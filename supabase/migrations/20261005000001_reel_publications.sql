-- Owner-controlled Reels queue. No client may mutate jobs or invoke worker RPCs.
CREATE TABLE public.instagram_publications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
 video_url text NOT NULL CHECK (length(video_url) <= 4096),
 caption text NOT NULL DEFAULT '' CHECK (char_length(caption) <= 2200),
 share_to_feed boolean NOT NULL DEFAULT true,
 publish_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN
   ('queued','processing','publishing','published','failed','cancelled','publication_unknown')),
 container_id text, media_id text, permalink text, error_code text,
 idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
 request_hash text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, metadata_attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 processing_started_at timestamptz,
 claim_token uuid, lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz,
 UNIQUE(user_id,idempotency_key)
);
CREATE INDEX publications_due ON public.instagram_publications(next_attempt_at)
 WHERE status IN ('queued','processing','publishing','published');
CREATE INDEX publications_owner ON public.instagram_publications(user_id,id);
CREATE INDEX publications_account ON public.instagram_publications(account_id,lease_expires_at);
ALTER TABLE public.instagram_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instagram_publications FROM anon,authenticated;
GRANT SELECT ON public.instagram_publications TO authenticated;
GRANT ALL ON public.instagram_publications TO service_role;
CREATE POLICY publication_owner_read ON public.instagram_publications FOR SELECT
 USING(auth.uid()=user_id);

CREATE FUNCTION public.publishing_enqueue(p_user uuid,p_account uuid,p_url text,p_caption text,
 p_feed boolean,p_at timestamptz,p_key text,p_hash text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p instagram_publications; a instagram_accounts;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('publication:'||p_user::text),hashtext(p_key));
 SELECT * INTO p FROM instagram_publications WHERE user_id=p_user AND idempotency_key=p_key;
 IF FOUND THEN
  IF p.request_hash<>p_hash THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
  RETURN to_jsonb(p);
 END IF;
 SELECT * INTO a FROM instagram_accounts WHERE id=p_account AND user_id=p_user FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF NOT a.is_active OR (a.token_expires_at IS NOT NULL AND a.token_expires_at<=now())
  THEN RAISE EXCEPTION 'account_unavailable'; END IF;
 INSERT INTO instagram_publications(user_id,account_id,video_url,caption,share_to_feed,
  publish_at,next_attempt_at,idempotency_key,request_hash)
 VALUES(p_user,p_account,p_url,p_caption,p_feed,coalesce(p_at,now()),coalesce(p_at,now()),p_key,p_hash)
 RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;

CREATE FUNCTION public.publishing_cancel(p_user uuid,p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p instagram_publications;
BEGIN
 SELECT * INTO p FROM instagram_publications WHERE id=p_id AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF p.status='cancelled' THEN RETURN to_jsonb(p); END IF;
 IF p.status NOT IN ('queued','processing') THEN RAISE EXCEPTION 'cannot_cancel'; END IF;
 UPDATE instagram_publications SET status='cancelled',claim_token=NULL,lease_expires_at=NULL,
  updated_at=now() WHERE id=p_id RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;

CREATE FUNCTION public.publishing_claim(p_limit integer DEFAULT 4) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p instagram_publications; jobs jsonb:='[]';
BEGIN
 -- Never repeat a publish after a crashed worker or an ambiguous DB response.
 UPDATE instagram_publications SET status='publication_unknown',error_code='meta_publish_outcome_unknown',
  claim_token=NULL,lease_expires_at=NULL,updated_at=now()
 WHERE status='publishing' AND lease_expires_at<=now();
 FOR p IN
  WITH candidates AS (
   SELECT DISTINCT ON(account_id) id,account_id,next_attempt_at FROM instagram_publications
   WHERE next_attempt_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now())
    AND (status IN('queued','processing') OR
      (status='published' AND media_id IS NOT NULL AND permalink IS NULL AND metadata_attempts<8))
   ORDER BY account_id,next_attempt_at,id
  )
  SELECT j.* FROM instagram_publications j JOIN candidates c ON c.id=j.id
  ORDER BY c.next_attempt_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 64
 LOOP
  EXIT WHEN jsonb_array_length(jobs)>=greatest(1,least(p_limit,16));
  IF NOT pg_try_advisory_xact_lock(hashtext('publication-account'),hashtext(p.account_id::text))
   THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM instagram_publications WHERE account_id=p.account_id
   AND lease_expires_at>now()) THEN CONTINUE; END IF;
  UPDATE instagram_publications SET claim_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes',
   attempts=attempts+CASE WHEN status='published' THEN 0 ELSE 1 END,
   metadata_attempts=metadata_attempts+CASE WHEN status='published' THEN 1 ELSE 0 END,
   updated_at=now() WHERE id=p.id RETURNING * INTO p;
  jobs:=jobs||jsonb_build_array(to_jsonb(p));
 END LOOP;
 RETURN jobs;
END $$;

CREATE FUNCTION public.publishing_context(p_id uuid,p_token uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p instagram_publications; a instagram_accounts;
BEGIN
 SELECT * INTO p FROM instagram_publications WHERE id=p_id AND claim_token=p_token
  AND lease_expires_at>now() AND status IN('queued','processing','published') FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO a FROM instagram_accounts WHERE id=p.account_id AND user_id=p.user_id FOR SHARE;
 IF a.id IS NULL OR NOT a.is_active OR (a.token_expires_at IS NOT NULL AND a.token_expires_at<=now()) THEN
  UPDATE instagram_publications SET status=CASE WHEN status='published' THEN status ELSE 'failed' END,
   error_code='account_unavailable',metadata_attempts=8,claim_token=NULL,lease_expires_at=NULL,
   updated_at=now() WHERE id=p.id;
  RETURN NULL;
 END IF;
 IF p.status<>'published' AND a.paused_until>now() THEN
  UPDATE instagram_publications SET next_attempt_at=a.paused_until,claim_token=NULL,
   lease_expires_at=NULL,updated_at=now() WHERE id=p.id;
  RETURN NULL;
 END IF;
 IF p.status<>'published' AND
  (p.attempts>120 OR p.publish_at<now()-interval '23 hours') THEN
  UPDATE instagram_publications SET status='failed',error_code='processing_timeout',
   claim_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=p.id;
  RETURN NULL;
 END IF;
 IF p.status='queued' THEN
  UPDATE instagram_publications SET status='processing',processing_started_at=now(),
   updated_at=now() WHERE id=p.id RETURNING * INTO p;
 END IF;
 RETURN jsonb_build_object('publication',to_jsonb(p),'account',jsonb_build_object(
  'id',a.id,'instagram_user_id',a.instagram_user_id,'access_token_encrypted',a.access_token_encrypted));
END $$;

CREATE FUNCTION public.publishing_begin_publish(p_id uuid,p_token uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p instagram_publications; a instagram_accounts;
BEGIN
 SELECT * INTO p FROM instagram_publications WHERE id=p_id AND claim_token=p_token
  AND lease_expires_at>now() AND status='processing' AND container_id IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO a FROM instagram_accounts WHERE id=p.account_id AND user_id=p.user_id FOR SHARE;
 IF a.id IS NULL OR NOT a.is_active OR a.paused_until>now()
  OR (a.token_expires_at IS NOT NULL AND a.token_expires_at<=now()) THEN RETURN false; END IF;
 UPDATE instagram_publications SET status='publishing',updated_at=now() WHERE id=p_id;
 RETURN true;
END $$;

CREATE FUNCTION public.publishing_finish(p_id uuid,p_token uuid,p_state text,p_container text DEFAULT NULL,
 p_media text DEFAULT NULL,p_permalink text DEFAULT NULL,p_error text DEFAULT NULL,p_delay integer DEFAULT 15)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF p_state NOT IN('processing','published','failed','publication_unknown') THEN
  RAISE EXCEPTION 'invalid_publication_state'; END IF;
 UPDATE instagram_publications SET status=p_state,container_id=coalesce(p_container,container_id),
  media_id=coalesce(p_media,media_id),permalink=coalesce(p_permalink,permalink),error_code=p_error,
  published_at=CASE WHEN p_state='published' THEN coalesce(published_at,now()) ELSE published_at END,
  next_attempt_at=now()+make_interval(secs=>greatest(5,least(p_delay,3600))),
  claim_token=NULL,lease_expires_at=NULL,updated_at=now()
 WHERE id=p_id AND claim_token=p_token AND status IN('processing','publishing','published');
 RETURN FOUND;
END $$;

-- Functions are called only by the trusted server. Ownership is checked by API and RPC.
REVOKE ALL ON FUNCTION public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text),
 public.publishing_cancel(uuid,uuid),public.publishing_claim(integer),public.publishing_context(uuid,uuid),
 public.publishing_begin_publish(uuid,uuid),public.publishing_finish(uuid,uuid,text,text,text,text,text,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text),
 public.publishing_cancel(uuid,uuid),public.publishing_claim(integer),public.publishing_context(uuid,uuid),
 public.publishing_begin_publish(uuid,uuid),public.publishing_finish(uuid,uuid,text,text,text,text,text,integer)
 TO service_role;
