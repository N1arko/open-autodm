-- Extend the existing durable publication queue; legacy Reels keep their defaults.
ALTER TABLE public.instagram_publications
 ALTER COLUMN video_url DROP NOT NULL,
 ADD COLUMN media_type text NOT NULL DEFAULT 'REELS'
   CHECK(media_type IN ('REELS','CAROUSEL','STORIES')),
 ADD COLUMN image_url text CHECK(image_url IS NULL OR length(image_url)<=4096),
 ADD COLUMN items jsonb NOT NULL DEFAULT '[]'
   CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)<=20),
 ADD COLUMN child_container_ids jsonb NOT NULL DEFAULT '[]'
   CHECK(jsonb_typeof(child_container_ids)='array');

ALTER TABLE public.instagram_publications ADD CONSTRAINT publication_media_shape CHECK (
 (media_type='REELS' AND video_url IS NOT NULL AND image_url IS NULL AND items='[]') OR
 (media_type='CAROUSEL' AND video_url IS NULL AND image_url IS NULL AND cover_url IS NULL
   AND jsonb_array_length(items) BETWEEN 2 AND 20) OR
 (media_type='STORIES' AND (video_url IS NULL)<>(image_url IS NULL)
   AND cover_url IS NULL AND items='[]' AND caption='')
);
ALTER TABLE public.instagram_publications ADD CONSTRAINT publication_child_count
 CHECK(jsonb_array_length(child_container_ids)<=jsonb_array_length(items));

-- Trailing defaults preserve the previous eight- and nine-argument callers.
DROP FUNCTION public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text,text);
CREATE FUNCTION public.publishing_enqueue(p_user uuid,p_account uuid,p_url text,p_caption text,
 p_feed boolean,p_at timestamptz,p_key text,p_hash text,p_cover text DEFAULT NULL,
 p_kind text DEFAULT 'REELS',p_image text DEFAULT NULL,p_items jsonb DEFAULT '[]') RETURNS jsonb
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
 IF jsonb_typeof(p_items)<>'array' OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(p_items) item WHERE NOT coalesce(
   jsonb_typeof(item)='object' AND item->>'media_type' IN ('IMAGE','VIDEO')
   AND length(item->>'url') BETWEEN 1 AND 4096,false))
  THEN RAISE EXCEPTION 'invalid_publication_media'; END IF;
 INSERT INTO instagram_publications(user_id,account_id,media_type,video_url,image_url,items,
  cover_url,caption,share_to_feed,publish_at,next_attempt_at,idempotency_key,request_hash)
 VALUES(p_user,p_account,p_kind,p_url,p_image,p_items,p_cover,p_caption,p_feed,
  coalesce(p_at,now()),coalesce(p_at,now()),p_key,p_hash) RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;

-- Persist exactly the next child's ID and release this claim before the next upload.
CREATE FUNCTION public.publishing_save_child(p_id uuid,p_token uuid,p_index integer,p_container text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF p_container IS NULL OR p_container !~ '^[0-9]{1,30}$' THEN
  RAISE EXCEPTION 'invalid_container_id'; END IF;
 UPDATE instagram_publications SET
  child_container_ids=child_container_ids||jsonb_build_array(p_container),
  next_attempt_at=now()+interval '5 seconds',claim_token=NULL,lease_expires_at=NULL,updated_at=now()
 WHERE id=p_id AND claim_token=p_token AND lease_expires_at>now() AND status='processing'
  AND media_type='CAROUSEL' AND container_id IS NULL
  AND jsonb_array_length(child_container_ids)=p_index AND p_index<jsonb_array_length(items);
 RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.publishing_finish(p_id uuid,p_token uuid,p_state text,
 p_container text DEFAULT NULL,p_media text DEFAULT NULL,p_permalink text DEFAULT NULL,
 p_error text DEFAULT NULL,p_delay integer DEFAULT 15) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF p_state NOT IN('processing','published','failed','publication_unknown') THEN
  RAISE EXCEPTION 'invalid_publication_state'; END IF;
 UPDATE instagram_publications SET status=p_state,container_id=coalesce(p_container,container_id),
  media_id=coalesce(p_media,media_id),permalink=coalesce(p_permalink,permalink),error_code=p_error,
  published_at=CASE WHEN p_state='published' THEN coalesce(published_at,now()) ELSE published_at END,
  -- Stories have no durable permalink. Avoid eight futile metadata retries after success.
  metadata_attempts=CASE WHEN media_type='STORIES' AND p_state='published' THEN 8 ELSE metadata_attempts END,
  next_attempt_at=now()+make_interval(secs=>greatest(5,least(p_delay,3600))),
  claim_token=NULL,lease_expires_at=NULL,updated_at=now()
 WHERE id=p_id AND claim_token=p_token AND status IN('processing','publishing','published');
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION
 public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text,text,text,text,jsonb),
 public.publishing_save_child(uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text,text,text,text,jsonb),
 public.publishing_save_child(uuid,uuid,integer,text) TO service_role;
