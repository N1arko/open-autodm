-- Read-only Marketing API connections. Credentials remain service-role only.
CREATE TABLE public.meta_ads_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 ad_account_id text NOT NULL CHECK(ad_account_id ~ '^[0-9]{1,30}$'),
 access_token_encrypted text NOT NULL,
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=8192),
 enabled boolean NOT NULL DEFAULT true,
 revision bigint NOT NULL DEFAULT 1,
 verified_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,ad_account_id)
);
CREATE TABLE public.meta_ads_cache (
 account_id uuid NOT NULL REFERENCES public.meta_ads_accounts(id) ON DELETE CASCADE,
 query_hash text NOT NULL, revision bigint NOT NULL,
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=1048576),
 fetched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,query_hash)
);
ALTER TABLE public.meta_ads_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_ads_accounts,public.meta_ads_cache FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.meta_ads_accounts,public.meta_ads_cache TO service_role;

CREATE FUNCTION public.ads_visible(p_row public.meta_ads_accounts) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT to_jsonb(p_row)-'user_id'-'access_token_encrypted';
$$;
CREATE FUNCTION public.ads_connect(p_user uuid,p_meta_id text,p_token text,p_metadata jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a meta_ads_accounts;
BEGIN
 INSERT INTO meta_ads_accounts(user_id,ad_account_id,access_token_encrypted,metadata)
 VALUES(p_user,p_meta_id,p_token,p_metadata)
 ON CONFLICT(user_id,ad_account_id) DO UPDATE SET
 access_token_encrypted=p_token,metadata=p_metadata,enabled=true,
 revision=meta_ads_accounts.revision+1,verified_at=now(),updated_at=now()
 RETURNING * INTO a;
 DELETE FROM meta_ads_cache WHERE account_id=a.id;
 RETURN ads_visible(a);
END $$;
CREATE FUNCTION public.ads_accounts(p_user uuid,p_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 WITH items AS (SELECT id,ads_visible(a) item FROM meta_ads_accounts a
 WHERE user_id=p_user AND (p_cursor IS NULL OR id>p_cursor) ORDER BY id LIMIT 51)
 SELECT jsonb_build_object('data',coalesce((SELECT jsonb_agg(item ORDER BY id) FROM
 (SELECT * FROM items ORDER BY id LIMIT 50) x),'[]'::jsonb),
 'next_cursor',(SELECT id FROM items ORDER BY id OFFSET 49 LIMIT 1)
 ) || jsonb_build_object('next_cursor',CASE WHEN (SELECT count(*) FROM items)>50
 THEN (SELECT id FROM items ORDER BY id OFFSET 49 LIMIT 1) ELSE NULL END);
$$;
CREATE FUNCTION public.ads_context(p_user uuid,p_account uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT to_jsonb(a) FROM meta_ads_accounts a WHERE id=p_account AND user_id=p_user;
$$;
CREATE FUNCTION public.ads_update(p_user uuid,p_account uuid,p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a meta_ads_accounts;
BEGIN
 UPDATE meta_ads_accounts SET enabled=p_enabled,revision=revision+1,updated_at=now()
 WHERE id=p_account AND user_id=p_user RETURNING * INTO a;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 DELETE FROM meta_ads_cache WHERE account_id=p_account;
 RETURN ads_visible(a);
END $$;
CREATE FUNCTION public.ads_rotate(p_user uuid,p_account uuid,p_token text,p_metadata jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a meta_ads_accounts;
BEGIN
 UPDATE meta_ads_accounts SET access_token_encrypted=p_token,metadata=p_metadata,
 revision=revision+1,verified_at=now(),updated_at=now()
 WHERE id=p_account AND user_id=p_user RETURNING * INTO a;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 DELETE FROM meta_ads_cache WHERE account_id=p_account;
 RETURN ads_visible(a);
END $$;
CREATE FUNCTION public.ads_cached(p_user uuid,p_account uuid,p_revision bigint,p_hash text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('payload',c.payload,'fetched_at',c.fetched_at)
 FROM meta_ads_cache c JOIN meta_ads_accounts a ON a.id=c.account_id
 WHERE a.id=p_account AND a.user_id=p_user AND a.enabled AND a.revision=p_revision
 AND c.revision=p_revision AND c.query_hash=p_hash AND c.fetched_at>now()-interval '5 minutes';
$$;
CREATE FUNCTION public.ads_save(p_user uuid,p_account uuid,p_revision bigint,p_hash text,p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM 1 FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user
 AND enabled AND revision=p_revision FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 DELETE FROM meta_ads_cache WHERE account_id=p_account AND fetched_at<now()-interval '1 day';
 INSERT INTO meta_ads_cache(account_id,query_hash,revision,payload)
 VALUES(p_account,p_hash,p_revision,p_payload)
 ON CONFLICT(account_id,query_hash) DO UPDATE SET revision=p_revision,payload=p_payload,fetched_at=now();
 DELETE FROM meta_ads_cache WHERE account_id=p_account AND query_hash IN
 (SELECT query_hash FROM meta_ads_cache WHERE account_id=p_account ORDER BY fetched_at DESC,query_hash OFFSET 100);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.ads_visible(public.meta_ads_accounts),public.ads_connect(uuid,text,text,jsonb),
 public.ads_accounts(uuid,uuid),public.ads_context(uuid,uuid),public.ads_update(uuid,uuid,boolean),
 public.ads_rotate(uuid,uuid,text,jsonb),public.ads_cached(uuid,uuid,bigint,text),public.ads_save(uuid,uuid,bigint,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ads_visible(public.meta_ads_accounts),public.ads_connect(uuid,text,text,jsonb),
 public.ads_accounts(uuid,uuid),public.ads_context(uuid,uuid),public.ads_update(uuid,uuid,boolean),
 public.ads_rotate(uuid,uuid,text,jsonb),public.ads_cached(uuid,uuid,bigint,text),public.ads_save(uuid,uuid,bigint,text,jsonb)
 TO service_role;
