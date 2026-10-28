-- Optional Trial Reels mode. Existing rows and enqueue hashes remain unchanged.
ALTER TABLE public.instagram_publications ADD COLUMN trial_params jsonb,
 ADD CONSTRAINT publication_trial_params CHECK(trial_params IS NULL OR coalesce(
  media_type='REELS' AND jsonb_typeof(trial_params)='object'
  AND trial_params ? 'graduation_strategy'
  AND trial_params - 'graduation_strategy' = '{}'::jsonb
  AND trial_params->>'graduation_strategy' IN('MANUAL','SS_PERFORMANCE'),false));

-- Keep the same signature, defaults, locking and dependent first-comment transaction.
CREATE OR REPLACE FUNCTION public.publishing_enqueue(p_user uuid,p_account uuid,p_url text,p_caption text,p_feed boolean,p_at timestamptz,p_key text,p_hash text,
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
   alt_text=p_options->>'alt_text',thumb_offset=(p_options->>'thumb_offset')::integer,is_ai_generated=(p_options->>'is_ai_generated')::boolean,
   trial_params=p_options->'trial_params'
  WHERE id=p.id RETURNING * INTO p;
 END IF;
 RETURN to_jsonb(p);
END $$;
REVOKE ALL ON FUNCTION public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text,text,text,text,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publishing_enqueue(uuid,uuid,text,text,boolean,timestamptz,text,text,text,text,text,jsonb,text,jsonb) TO service_role;
