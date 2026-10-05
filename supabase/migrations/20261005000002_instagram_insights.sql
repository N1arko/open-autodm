-- Owner Insights cache/history and opt-in daily collection, independent of bot jobs.
CREATE TABLE public.instagram_insights_settings (
 account_id uuid PRIMARY KEY REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 media_limit integer NOT NULL DEFAULT 10 CHECK(media_limit BETWEEN 0 AND 50),
 retention_days integer NOT NULL DEFAULT 90 CHECK(retention_days BETWEEN 30 AND 730),
 next_run_at timestamptz NOT NULL DEFAULT now(), last_collected_at timestamptz,
 last_error text, claim_token uuid, lease_expires_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insights_due ON public.instagram_insights_settings(next_run_at) WHERE enabled;
CREATE TABLE public.instagram_insights_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('account','media','audience')),
 target_id text NOT NULL CHECK(target_id ~ '^[0-9]{1,30}$'),
 query_hash text NOT NULL, query jsonb NOT NULL, payload jsonb NOT NULL,
 collected_on date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
 fetched_at timestamptz NOT NULL DEFAULT now(),
 CHECK(octet_length(payload::text)<=262144),
 UNIQUE(account_id,kind,target_id,query_hash,collected_on)
);
CREATE INDEX insights_cache ON public.instagram_insights_snapshots(account_id,kind,target_id,query_hash,fetched_at DESC);
CREATE INDEX insights_history ON public.instagram_insights_snapshots(account_id,collected_on,id);
ALTER TABLE public.instagram_insights_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_insights_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instagram_insights_settings,public.instagram_insights_snapshots FROM anon,authenticated;
GRANT SELECT ON public.instagram_insights_settings,public.instagram_insights_snapshots TO authenticated;
GRANT ALL ON public.instagram_insights_settings,public.instagram_insights_snapshots TO service_role;
CREATE POLICY insights_settings_owner ON public.instagram_insights_settings FOR SELECT USING(auth.uid()=user_id);
CREATE POLICY insights_snapshots_owner ON public.instagram_insights_snapshots FOR SELECT USING(auth.uid()=user_id);

CREATE FUNCTION public.insights_configure(p_user uuid,p_account uuid,p_enabled boolean,p_limit integer,p_retention integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM instagram_accounts WHERE id=p_account AND user_id=p_user) THEN
  RAISE EXCEPTION 'not_found'; END IF;
 INSERT INTO instagram_insights_settings(account_id,user_id,enabled,media_limit,retention_days)
 VALUES(p_account,p_user,p_enabled,p_limit,p_retention)
 ON CONFLICT(account_id) DO UPDATE SET enabled=p_enabled,media_limit=p_limit,retention_days=p_retention,
 next_run_at=CASE WHEN p_enabled AND NOT instagram_insights_settings.enabled THEN now()
   ELSE instagram_insights_settings.next_run_at END,
 claim_token=CASE WHEN p_enabled THEN instagram_insights_settings.claim_token ELSE NULL END,
 lease_expires_at=CASE WHEN p_enabled THEN instagram_insights_settings.lease_expires_at ELSE NULL END,
 updated_at=now();
 RETURN (SELECT to_jsonb(s)-'user_id'-'claim_token'-'lease_expires_at' FROM instagram_insights_settings s WHERE account_id=p_account);
END $$;
CREATE FUNCTION public.insights_save(p_user uuid,p_account uuid,p_kind text,p_target text,p_hash text,p_query jsonb,p_payload jsonb,p_claim uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM instagram_accounts WHERE id=p_account AND user_id=p_user AND is_active) THEN
  RAISE EXCEPTION 'not_found'; END IF;
 IF p_claim IS NOT NULL THEN
  PERFORM 1 FROM instagram_insights_settings WHERE account_id=p_account AND enabled
   AND claim_token=p_claim AND lease_expires_at>now() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
 END IF;
 INSERT INTO instagram_insights_snapshots(user_id,account_id,kind,target_id,query_hash,query,payload)
 VALUES(p_user,p_account,p_kind,p_target,p_hash,p_query,p_payload)
 ON CONFLICT(account_id,kind,target_id,query_hash,collected_on) DO UPDATE
 SET query=p_query,payload=p_payload,fetched_at=now();
 RETURN true;
END $$;
CREATE FUNCTION public.insights_history(p_user uuid,p_account uuid,p_kind text,p_target text,p_from date,p_to date,p_cursor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE items jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM instagram_accounts WHERE id=p_account AND user_id=p_user) THEN RAISE EXCEPTION 'not_found'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO items FROM
 (SELECT id,kind,target_id,query,payload,collected_on,fetched_at FROM instagram_insights_snapshots
  WHERE account_id=p_account AND user_id=p_user AND (p_kind IS NULL OR kind=p_kind)
   AND (p_target IS NULL OR target_id=p_target) AND collected_on>=p_from AND collected_on<p_to
   AND (p_cursor IS NULL OR id>p_cursor) ORDER BY id LIMIT 51) x;
 RETURN jsonb_build_object('data',(SELECT coalesce(jsonb_agg(value),'[]') FROM jsonb_array_elements(items) WITH ORDINALITY t(value,n) WHERE n<=50),
  'next_cursor',CASE WHEN jsonb_array_length(items)>50 THEN items->49->>'id' ELSE NULL END);
END $$;
CREATE FUNCTION public.insights_claim(p_limit integer DEFAULT 2) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s instagram_insights_settings; result jsonb:='[]';
BEGIN
 FOR s IN SELECT * FROM instagram_insights_settings WHERE enabled AND next_run_at<=now()
  AND (lease_expires_at IS NULL OR lease_expires_at<=now()) ORDER BY next_run_at,account_id
  FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,4)) LOOP
  UPDATE instagram_insights_settings SET claim_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes'
   WHERE account_id=s.account_id RETURNING * INTO s;
  result:=result||jsonb_build_array(to_jsonb(s));
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION public.insights_context(p_account uuid,p_claim uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('id',a.id,'user_id',a.user_id,'instagram_user_id',a.instagram_user_id,
  'access_token_encrypted',a.access_token_encrypted,'is_active',a.is_active,'token_expires_at',a.token_expires_at,
  'paused_until',a.paused_until)
 FROM instagram_accounts a JOIN instagram_insights_settings s ON s.account_id=a.id AND s.user_id=a.user_id
 WHERE a.id=p_account AND s.enabled AND s.claim_token=p_claim AND s.lease_expires_at>now();
$$;
CREATE FUNCTION public.insights_finish(p_account uuid,p_claim uuid,p_error text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE instagram_insights_settings SET last_error=p_error,
 last_collected_at=CASE WHEN p_error IS NULL THEN now() ELSE last_collected_at END,
 next_run_at=now()+CASE WHEN p_error IS NULL THEN interval '1 day'
   WHEN p_error IN('insights_permission_required','account_unavailable') THEN interval '1 day'
   ELSE interval '6 hours' END,
 claim_token=NULL,lease_expires_at=NULL,updated_at=now()
 WHERE account_id=p_account AND enabled AND claim_token=p_claim AND lease_expires_at>now();
 RETURN FOUND;
END $$;
CREATE FUNCTION public.insights_cleanup() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE removed integer;
BEGIN
 DELETE FROM instagram_insights_snapshots p WHERE collected_on<
  (now() AT TIME ZONE 'UTC')::date-coalesce((SELECT retention_days FROM instagram_insights_settings WHERE account_id=p.account_id),90);
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION public.insights_configure(uuid,uuid,boolean,integer,integer),
 public.insights_save(uuid,uuid,text,text,text,jsonb,jsonb,uuid),public.insights_history(uuid,uuid,text,text,date,date,uuid),
 public.insights_claim(integer),public.insights_context(uuid,uuid),public.insights_finish(uuid,uuid,text),public.insights_cleanup()
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.insights_configure(uuid,uuid,boolean,integer,integer),
 public.insights_save(uuid,uuid,text,text,text,jsonb,jsonb,uuid),public.insights_history(uuid,uuid,text,text,date,date,uuid),
 public.insights_claim(integer),public.insights_context(uuid,uuid),public.insights_finish(uuid,uuid,text),public.insights_cleanup()
 TO service_role;
