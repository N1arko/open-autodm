-- Private short-lived image staging and immutable versions of service-owned Direct templates.
CREATE TABLE public.meta_ads_image_uploads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES public.meta_ads_accounts(id) ON DELETE CASCADE,
 metadata jsonb NOT NULL CHECK(octet_length(metadata::text)<2048),
 bytes_encrypted text NOT NULL CHECK(length(bytes_encrypted) BETWEEN 1 AND 23000000),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour'
);
CREATE INDEX meta_ads_image_upload_expiry ON public.meta_ads_image_uploads(expires_at);
CREATE TABLE public.meta_ads_chat_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES public.meta_ads_accounts(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200), version int NOT NULL DEFAULT 1,
 archived boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.meta_ads_chat_template_versions (
 template_id uuid NOT NULL REFERENCES public.meta_ads_chat_templates(id) ON DELETE CASCADE,
 version int NOT NULL, body jsonb NOT NULL CHECK(octet_length(body::text)<=8192), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(template_id,version)
);
ALTER TABLE public.meta_ads_image_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_chat_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_chat_template_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_ads_image_uploads,public.meta_ads_chat_templates,public.meta_ads_chat_template_versions FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.meta_ads_image_uploads,public.meta_ads_chat_templates,public.meta_ads_chat_template_versions TO service_role;

CREATE FUNCTION public.ads_image_stage(p_user uuid,p_account uuid,p_metadata jsonb,p_bytes text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE row meta_ads_image_uploads;
BEGIN
 PERFORM 1 FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user AND enabled FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 DELETE FROM meta_ads_image_uploads WHERE expires_at<=now();
 IF (SELECT count(*) FROM meta_ads_image_uploads WHERE account_id=p_account)>=10 THEN RAISE EXCEPTION 'image_staging_limit'; END IF;
 INSERT INTO meta_ads_image_uploads(account_id,metadata,bytes_encrypted) VALUES(p_account,p_metadata,p_bytes) RETURNING * INTO row;
 RETURN to_jsonb(row)-'bytes_encrypted';
END $$;
CREATE FUNCTION public.ads_image_staged(p_user uuid,p_account uuid,p_upload uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT to_jsonb(u) FROM meta_ads_image_uploads u JOIN meta_ads_accounts a ON a.id=u.account_id
 WHERE a.id=p_account AND a.user_id=p_user AND u.id=p_upload AND u.expires_at>now();
$$;
CREATE FUNCTION public.ads_creative_cleanup() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE removed int;
BEGIN DELETE FROM meta_ads_image_uploads WHERE expires_at<=now(); GET DIAGNOSTICS removed=ROW_COUNT; RETURN removed; END $$;

-- Remove the large staged bytes in the same transaction as a confirmed upload receipt.
-- Unknown writes retain their staging until expiry and remain protected by the operation guard.
CREATE OR REPLACE FUNCTION public.ads_operation_finish(p_user uuid,p_account uuid,p_operation uuid,p_state text,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o meta_ads_operations;
BEGIN
 PERFORM 1 FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF p_state NOT IN ('succeeded','failed','uncertain','cancelled') THEN RAISE EXCEPTION 'invalid_state'; END IF;
 UPDATE meta_ads_operations SET state=p_state,result=p_result,updated_at=now() WHERE id=p_operation AND account_id=p_account AND state IN ('executing','uncertain') RETURNING * INTO o;
 IF NOT FOUND THEN SELECT * INTO o FROM meta_ads_operations WHERE id=p_operation AND account_id=p_account; RETURN to_jsonb(o); END IF;
 IF p_state IN ('succeeded','uncertain') THEN
  UPDATE meta_ads_accounts SET revision=revision+1,updated_at=now() WHERE id=p_account;
  DELETE FROM meta_ads_cache WHERE account_id=p_account;
 END IF;
 IF p_state='succeeded' AND o.plan->'action'->>'action'='image.upload' THEN
  DELETE FROM meta_ads_image_uploads WHERE account_id=p_account AND id=(o.plan->'action'->'params'->>'upload_id')::uuid;
 END IF;
 RETURN to_jsonb(o);
END $$;

CREATE FUNCTION public.ads_template_save(p_user uuid,p_account uuid,p_id uuid,p_expected int,p_name text,p_body jsonb,p_archived boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t meta_ads_chat_templates;
BEGIN
 PERFORM 1 FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF p_id IS NULL THEN
  IF p_archived OR p_expected IS NOT NULL OR p_body IS NULL THEN RAISE EXCEPTION 'invalid_template'; END IF;
  IF (SELECT count(*) FROM meta_ads_chat_templates WHERE account_id=p_account)>=200 THEN RAISE EXCEPTION 'template_limit'; END IF;
  INSERT INTO meta_ads_chat_templates(account_id,name) VALUES(p_account,p_name) RETURNING * INTO t;
 ELSE
  SELECT * INTO t FROM meta_ads_chat_templates WHERE id=p_id AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF t.version IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'template_version_changed'; END IF;
  IF p_body IS NOT NULL AND t.version>=100 THEN RAISE EXCEPTION 'template_version_limit'; END IF;
  IF p_body IS NULL AND NOT p_archived THEN RAISE EXCEPTION 'invalid_template'; END IF;
  UPDATE meta_ads_chat_templates SET name=coalesce(p_name,name),version=version+CASE WHEN p_body IS NULL THEN 0 ELSE 1 END,
   archived=p_archived,updated_at=now() WHERE id=t.id RETURNING * INTO t;
 END IF;
 IF p_body IS NOT NULL THEN INSERT INTO meta_ads_chat_template_versions(template_id,version,body) VALUES(t.id,t.version,p_body); END IF;
 RETURN to_jsonb(t);
END $$;
CREATE FUNCTION public.ads_templates(p_user uuid,p_account uuid,p_id uuid DEFAULT NULL,p_version int DEFAULT NULL,p_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb;
BEGIN
 PERFORM 1 FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF p_id IS NOT NULL THEN
  SELECT to_jsonb(t)||jsonb_build_object('selected_version',v.version,'body',v.body) INTO result
   FROM meta_ads_chat_templates t JOIN meta_ads_chat_template_versions v ON v.template_id=t.id AND v.version=coalesce(p_version,t.version)
   WHERE t.id=p_id AND t.account_id=p_account;
  RETURN result;
 END IF;
 SELECT jsonb_build_object('data',coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb)) INTO result
  FROM (SELECT * FROM meta_ads_chat_templates WHERE account_id=p_account AND (p_cursor IS NULL OR id>p_cursor) ORDER BY id LIMIT 51) x;
 IF jsonb_array_length(result->'data')>50 THEN
  result=jsonb_build_object('data',(SELECT jsonb_agg(value) FROM jsonb_array_elements(result->'data') WITH ORDINALITY a(value,n) WHERE n<=50),'next_cursor',result->'data'->49->'id');
 ELSE result=result||jsonb_build_object('next_cursor',NULL); END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.ads_image_stage(uuid,uuid,jsonb,text),public.ads_image_staged(uuid,uuid,uuid),public.ads_creative_cleanup(),public.ads_template_save(uuid,uuid,uuid,int,text,jsonb,boolean),public.ads_templates(uuid,uuid,uuid,int,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ads_image_stage(uuid,uuid,jsonb,text),public.ads_image_staged(uuid,uuid,uuid),public.ads_creative_cleanup(),public.ads_template_save(uuid,uuid,uuid,int,text,jsonb,boolean),public.ads_templates(uuid,uuid,uuid,int,uuid) TO service_role;
