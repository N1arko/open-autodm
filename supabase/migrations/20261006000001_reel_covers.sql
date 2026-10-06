-- Optional cover images share the publication's durable queue and idempotency.
ALTER TABLE public.instagram_publications ADD COLUMN cover_url text
 CHECK (cover_url IS NULL OR length(cover_url) <= 4096);

-- A trailing default preserves calls from the previously deployed API.
DROP FUNCTION public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text);
CREATE FUNCTION public.publishing_enqueue(p_user uuid,p_account uuid,p_url text,p_caption text,
 p_feed boolean,p_at timestamptz,p_key text,p_hash text,p_cover text DEFAULT NULL) RETURNS jsonb
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
 INSERT INTO instagram_publications(user_id,account_id,video_url,cover_url,caption,share_to_feed,
  publish_at,next_attempt_at,idempotency_key,request_hash)
 VALUES(p_user,p_account,p_url,p_cover,p_caption,p_feed,coalesce(p_at,now()),coalesce(p_at,now()),p_key,p_hash)
 RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;
REVOKE ALL ON FUNCTION public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text,text)
 TO service_role;
