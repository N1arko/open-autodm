-- Typed Instagram actions. Worker credentials stay server-side; owner reads use RLS.
CREATE TABLE public.instagram_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
 publication_id uuid REFERENCES public.instagram_publications(id) ON DELETE CASCADE,
 action text NOT NULL CHECK(action IN('comment.create','comment.reply','comment.hide','comment.delete','media.comments')),
 input jsonb NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 request_hash text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','preparing','executing','succeeded','failed','unknown','cancelled')),
 receipt jsonb, error_code text, attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), claim_token uuid, lease_expires_at timestamptz,
 started_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,idempotency_key), UNIQUE(publication_id)
);
CREATE INDEX instagram_operations_due ON public.instagram_operations(next_attempt_at) WHERE status IN('queued','preparing','executing');
ALTER TABLE public.instagram_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instagram_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.instagram_operations TO authenticated;
GRANT ALL ON public.instagram_operations TO service_role;
CREATE POLICY instagram_operation_owner ON public.instagram_operations FOR SELECT USING(auth.uid()=user_id);

CREATE FUNCTION public.instagram_enqueue(p_user uuid,p_account uuid,p_action text,p_input jsonb,p_key text,p_hash text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o instagram_operations; a instagram_accounts;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('instagram-operation:'||p_user::text),hashtext(p_key));
 SELECT * INTO o FROM instagram_operations WHERE user_id=p_user AND idempotency_key=p_key;
 IF FOUND THEN
  IF o.request_hash<>p_hash THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
  RETURN to_jsonb(o);
 END IF;
 SELECT * INTO a FROM instagram_accounts WHERE id=p_account AND user_id=p_user FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF NOT a.is_active OR a.token_expires_at<=now() OR a.paused_until>now() THEN RAISE EXCEPTION 'account_unavailable'; END IF;
 IF (SELECT count(*) FROM instagram_operations WHERE account_id=p_account AND status IN('queued','preparing','executing'))>=100
  THEN RAISE EXCEPTION 'operation_queue_full'; END IF;
 INSERT INTO instagram_operations(user_id,account_id,action,input,idempotency_key,request_hash)
 VALUES(p_user,p_account,p_action,p_input,p_key,p_hash) RETURNING * INTO o;
 RETURN to_jsonb(o);
END $$;
CREATE FUNCTION public.instagram_claim(p_limit integer DEFAULT 4) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o instagram_operations; jobs jsonb:='[]';
BEGIN
 UPDATE instagram_operations SET status='unknown',error_code='meta_outcome_unknown',claim_token=NULL,lease_expires_at=NULL,updated_at=now()
 WHERE status='executing' AND lease_expires_at<=now();
 UPDATE instagram_operations target SET status='failed',error_code='publication_'||p.status,updated_at=now()
 FROM instagram_publications p WHERE p.id=target.publication_id AND target.status='queued' AND p.status IN('failed','cancelled','publication_unknown');
 FOR o IN SELECT * FROM instagram_operations j WHERE j.status IN('queued','preparing') AND j.next_attempt_at<=now()
  AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=now())
  AND (j.publication_id IS NULL OR EXISTS(SELECT 1 FROM instagram_publications p WHERE p.id=j.publication_id AND p.status='published' AND p.media_id IS NOT NULL))
  ORDER BY j.next_attempt_at,j.id FOR UPDATE SKIP LOCKED LIMIT 64
 LOOP
  EXIT WHEN jsonb_array_length(jobs)>=greatest(1,least(p_limit,8));
  IF NOT pg_try_advisory_xact_lock(hashtext('instagram-action-account'),hashtext(o.account_id::text)) THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM instagram_operations WHERE account_id=o.account_id AND lease_expires_at>now()) THEN CONTINUE; END IF;
  UPDATE instagram_operations SET status='preparing',claim_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',attempts=attempts+1,updated_at=now()
  WHERE id=o.id RETURNING * INTO o;
  IF o.publication_id IS NOT NULL THEN
   SELECT o.input||jsonb_build_object('media_id',p.media_id) INTO o.input FROM instagram_publications p WHERE p.id=o.publication_id;
   UPDATE instagram_operations SET input=o.input WHERE id=o.id;
  END IF;
  jobs:=jobs||jsonb_build_array(to_jsonb(o));
 END LOOP;
 RETURN jobs;
END $$;
CREATE FUNCTION public.instagram_begin(p_id uuid,p_token uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE instagram_operations o SET status='executing',started_at=now(),updated_at=now()
 WHERE o.id=p_id AND o.claim_token=p_token AND o.lease_expires_at>now()+interval '45 seconds' AND o.status='preparing'
 AND EXISTS(SELECT 1 FROM instagram_accounts a WHERE a.id=o.account_id AND a.user_id=o.user_id AND a.is_active
  AND (a.token_expires_at IS NULL OR a.token_expires_at>now()) AND (a.paused_until IS NULL OR a.paused_until<=now()));
 RETURN FOUND;
END $$;
CREATE FUNCTION public.instagram_finish(p_id uuid,p_token uuid,p_state text,p_receipt jsonb DEFAULT NULL,p_error text DEFAULT NULL,p_delay integer DEFAULT 60)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF p_state NOT IN('queued','succeeded','failed','unknown') THEN RAISE EXCEPTION 'invalid_operation_state'; END IF;
 UPDATE instagram_operations SET status=p_state,receipt=coalesce(p_receipt,receipt),error_code=p_error,
  next_attempt_at=now()+make_interval(secs=>greatest(5,least(p_delay,3600))),claim_token=NULL,lease_expires_at=NULL,updated_at=now()
 WHERE id=p_id AND claim_token=p_token AND lease_expires_at>now() AND status IN('preparing','executing');
 RETURN FOUND;
END $$;
CREATE FUNCTION public.instagram_cancel(p_user uuid,p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o instagram_operations;
BEGIN
 SELECT * INTO o FROM instagram_operations WHERE id=p_id AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF o.status='cancelled' THEN RETURN to_jsonb(o); END IF;
 IF o.status NOT IN('queued','preparing') THEN RAISE EXCEPTION 'cannot_cancel'; END IF;
 UPDATE instagram_operations SET status='cancelled',claim_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=p_id RETURNING * INTO o;
 RETURN to_jsonb(o);
END $$;
CREATE FUNCTION public.instagram_reconcile(p_user uuid,p_id uuid,p_receipt jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o instagram_operations;
BEGIN
 UPDATE instagram_operations SET status='succeeded',receipt=p_receipt,error_code=NULL,updated_at=now()
 WHERE id=p_id AND user_id=p_user AND status IN('unknown','succeeded') RETURNING * INTO o;
 IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_reconcilable'; END IF;
 RETURN to_jsonb(o);
END $$;

ALTER TABLE public.instagram_publications
 DROP CONSTRAINT instagram_publications_media_type_check,
 DROP CONSTRAINT publication_media_shape,
 ADD CONSTRAINT instagram_publications_media_type_check CHECK(media_type IN('REELS','IMAGE','CAROUSEL','STORIES')),
 ADD COLUMN alt_text text CHECK(alt_text IS NULL OR char_length(alt_text)<=1000),
 ADD COLUMN thumb_offset integer CHECK(thumb_offset BETWEEN 0 AND 900000),
 ADD COLUMN is_ai_generated boolean,
 ADD COLUMN first_comment text CHECK(first_comment IS NULL OR char_length(first_comment) BETWEEN 1 AND 2200),
 ADD COLUMN first_comment_operation_id uuid REFERENCES public.instagram_operations(id) ON DELETE SET NULL,
 ADD COLUMN revision integer NOT NULL DEFAULT 0,
 ADD CONSTRAINT publication_media_shape CHECK(
  (media_type='REELS' AND video_url IS NOT NULL AND image_url IS NULL AND items='[]') OR
  (media_type='IMAGE' AND image_url IS NOT NULL AND video_url IS NULL AND cover_url IS NULL AND items='[]') OR
  (media_type='CAROUSEL' AND video_url IS NULL AND image_url IS NULL AND cover_url IS NULL AND jsonb_array_length(items) BETWEEN 2 AND 20) OR
  (media_type='STORIES' AND (video_url IS NULL)<>(image_url IS NULL) AND cover_url IS NULL AND items='[]' AND caption='' AND first_comment IS NULL));
-- Preserve old overload via a wrapper, including all existing request hashes and jobs.
ALTER FUNCTION public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text,text,text,text,jsonb) RENAME TO publishing_enqueue_legacy;
CREATE FUNCTION public.publishing_enqueue(p_user uuid,p_account uuid,p_url text,p_caption text,p_feed boolean,p_at timestamptz,p_key text,p_hash text,
 p_cover text DEFAULT NULL,p_kind text DEFAULT 'REELS',p_image text DEFAULT NULL,p_items jsonb DEFAULT '[]',p_first_comment text DEFAULT NULL,p_options jsonb DEFAULT '{}')
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p instagram_publications; o uuid; existed boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('publication:'||p_user::text),hashtext(p_key));
 SELECT EXISTS(SELECT 1 FROM instagram_publications WHERE user_id=p_user AND idempotency_key=p_key) INTO existed;
 SELECT * INTO p FROM jsonb_populate_record(NULL::instagram_publications,
  publishing_enqueue_legacy(p_user,p_account,p_url,p_caption,p_feed,p_at,p_key,p_hash,p_cover,p_kind,p_image,p_items));
 IF NOT existed THEN
  IF p_first_comment IS NOT NULL THEN
   INSERT INTO instagram_operations(user_id,account_id,publication_id,action,input,idempotency_key,request_hash)
   VALUES(p_user,p_account,p.id,'comment.create',jsonb_build_object('text',p_first_comment),'publication:'||p.id,p_hash) RETURNING id INTO o;
  END IF;
  UPDATE instagram_publications SET first_comment=p_first_comment,first_comment_operation_id=o,
   alt_text=p_options->>'alt_text',thumb_offset=(p_options->>'thumb_offset')::integer,is_ai_generated=(p_options->>'is_ai_generated')::boolean
  WHERE id=p.id RETURNING * INTO p;
 END IF;
 RETURN to_jsonb(p);
END $$;
CREATE FUNCTION public.publishing_edit(p_user uuid,p_id uuid,p_revision integer,p_caption text DEFAULT NULL,p_at timestamptz DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p instagram_publications;
BEGIN
 SELECT * INTO p FROM instagram_publications WHERE id=p_id AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF p.status<>'queued' OR p.claim_token IS NOT NULL OR p.revision<>p_revision THEN RAISE EXCEPTION 'publication_edit_conflict'; END IF;
 UPDATE instagram_publications SET caption=coalesce(p_caption,caption),publish_at=coalesce(p_at,publish_at),next_attempt_at=coalesce(p_at,publish_at),revision=revision+1,updated_at=now()
 WHERE id=p_id RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;

-- Retained normalized observations, independently of bot bindings and keyword automations.
CREATE TABLE public.instagram_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 event_key text NOT NULL, field text NOT NULL, payload jsonb NOT NULL,
 occurred_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),UNIQUE(account_id,event_key)
);
CREATE INDEX instagram_events_account ON public.instagram_events(account_id,id);
ALTER TABLE public.instagram_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instagram_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.instagram_events TO authenticated;
GRANT ALL ON public.instagram_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.instagram_events_id_seq TO service_role;
CREATE POLICY instagram_event_owner ON public.instagram_events FOR SELECT USING(auth.uid()=user_id);
CREATE FUNCTION public.instagram_record_event(p_account uuid,p_key text,p_field text,p_payload jsonb,p_at timestamptz) RETURNS void
 LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 INSERT INTO instagram_events(account_id,user_id,event_key,field,payload,occurred_at)
 SELECT id,user_id,p_key,p_field,p_payload,p_at FROM instagram_accounts WHERE id=p_account
 ON CONFLICT(account_id,event_key) DO NOTHING;
$$;

-- Private direct uploads. The app never proxies large video bytes.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 VALUES('instagram-materials','instagram-materials',false,314572800,ARRAY['image/jpeg','video/mp4','video/quicktime']) ON CONFLICT(id) DO NOTHING;
CREATE TABLE public.instagram_materials (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
 object_path text NOT NULL UNIQUE,mime text NOT NULL CHECK(mime IN('image/jpeg','video/mp4','video/quicktime')),
 size bigint NOT NULL CHECK(size BETWEEN 1 AND 314572800),status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','ready')),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.instagram_materials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instagram_materials FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.instagram_materials TO service_role;
-- Functions remain private to trusted server, including the renamed legacy helper.
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND proname IN('instagram_enqueue','instagram_claim','instagram_begin','instagram_finish','instagram_cancel','instagram_reconcile','instagram_record_event','publishing_enqueue','publishing_enqueue_legacy','publishing_edit')
 LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||f.signature||' FROM PUBLIC,anon,authenticated';
 EXECUTE 'GRANT EXECUTE ON FUNCTION '||f.signature||' TO service_role'; END LOOP;
END $$;
ALTER TABLE public.instagram_materials ADD COLUMN idempotency_key text, ADD COLUMN request_hash text, ADD UNIQUE(user_id,idempotency_key);
CREATE FUNCTION public.instagram_material_prepare(p_user uuid,p_account uuid,p_mime text,p_size bigint,p_key text,p_hash text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE m instagram_materials; uid uuid:=gen_random_uuid();
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('instagram-material:'||p_user::text),hashtext(p_key));
 SELECT * INTO m FROM instagram_materials WHERE user_id=p_user AND idempotency_key=p_key;
 IF FOUND THEN
  IF m.request_hash<>p_hash THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;RETURN to_jsonb(m);
 END IF;
 PERFORM 1 FROM instagram_accounts WHERE user_id=p_user AND id=p_account FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF (SELECT count(*) FROM instagram_materials WHERE account_id=p_account AND status='pending')>=20 THEN RAISE EXCEPTION 'material_limit'; END IF;
 INSERT INTO instagram_materials(id,user_id,account_id,object_path,mime,size,idempotency_key,request_hash)
 VALUES(uid,p_user,p_account,p_user||'/'||p_account||'/'||uid||CASE WHEN p_mime='image/jpeg' THEN '.jpg' WHEN p_mime='video/mp4' THEN '.mp4' ELSE '.mov' END,p_mime,p_size,p_key,p_hash) RETURNING * INTO m;
 RETURN to_jsonb(m);
END $$;
CREATE FUNCTION public.instagram_event_cleanup() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE removed bigint;
BEGIN DELETE FROM instagram_events WHERE received_at<now()-interval '30 days';GET DIAGNOSTICS removed=ROW_COUNT;RETURN removed;END $$;
REVOKE ALL ON FUNCTION public.instagram_material_prepare(uuid,uuid,text,bigint,text,text),public.instagram_event_cleanup() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.instagram_material_prepare(uuid,uuid,text,bigint,text,text),public.instagram_event_cleanup() TO service_role;
