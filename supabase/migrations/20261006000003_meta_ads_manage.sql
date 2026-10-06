CREATE TABLE public.meta_ads_policy (
 account_id uuid PRIMARY KEY REFERENCES public.meta_ads_accounts(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 max_daily_budget_minor text CHECK(max_daily_budget_minor ~ '^[1-9][0-9]{0,14}$'),
 max_lifetime_budget_minor text CHECK(max_lifetime_budget_minor ~ '^[1-9][0-9]{0,14}$'),
 revision bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.meta_ads_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES public.meta_ads_accounts(id) ON DELETE CASCADE,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128), request_hash text NOT NULL,
 account_revision bigint NOT NULL, policy_revision bigint NOT NULL, plan_hash text NOT NULL,
 plan jsonb NOT NULL CHECK(octet_length(plan::text)<=65536),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','executing','succeeded','failed','uncertain','cancelled')),
 result jsonb CHECK(octet_length(result::text)<=8192),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 UNIQUE(account_id,idempotency_key)
);
CREATE UNIQUE INDEX meta_ads_one_executing ON public.meta_ads_operations(account_id) WHERE state='executing';
ALTER TABLE public.meta_ads_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_ads_policy,public.meta_ads_operations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.meta_ads_policy,public.meta_ads_operations TO service_role;
CREATE FUNCTION public.ads_policy(p_user uuid,p_account uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT to_jsonb(p) FROM meta_ads_policy p JOIN meta_ads_accounts a ON a.id=p.account_id WHERE a.id=p_account AND a.user_id=p_user;
$$;
CREATE FUNCTION public.ads_policy_set(p_user uuid,p_account uuid,p_enabled boolean,p_currency text,p_daily text,p_lifetime text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p meta_ads_policy;
BEGIN
 PERFORM 1 FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user AND metadata->>'currency'=p_currency FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF EXISTS(SELECT 1 FROM meta_ads_operations WHERE account_id=p_account AND state='executing') THEN RAISE EXCEPTION 'operation_in_progress'; END IF;
 INSERT INTO meta_ads_policy(account_id,enabled,currency,max_daily_budget_minor,max_lifetime_budget_minor)
 VALUES(p_account,p_enabled,p_currency,p_daily,p_lifetime)
 ON CONFLICT(account_id) DO UPDATE SET enabled=p_enabled,currency=p_currency,max_daily_budget_minor=p_daily,max_lifetime_budget_minor=p_lifetime,revision=meta_ads_policy.revision+1,updated_at=now()
 RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;
CREATE FUNCTION public.ads_operation_find(p_user uuid,p_account uuid,p_key text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT to_jsonb(o) FROM meta_ads_operations o JOIN meta_ads_accounts a ON a.id=o.account_id WHERE a.id=p_account AND a.user_id=p_user AND o.idempotency_key=p_key;
$$;
CREATE FUNCTION public.ads_operation_prepare(p_user uuid,p_account uuid,p_key text,p_request text,p_revision bigint,p_policy bigint,p_hash text,p_plan jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o meta_ads_operations;
BEGIN
 PERFORM 1 FROM meta_ads_accounts a JOIN meta_ads_policy p ON p.account_id=a.id
 WHERE a.id=p_account AND a.user_id=p_user AND a.enabled AND a.revision=p_revision AND p.enabled AND p.revision=p_policy FOR UPDATE OF a,p;
 IF NOT FOUND THEN RAISE EXCEPTION 'ads_connection_changed'; END IF;
 INSERT INTO meta_ads_operations(account_id,idempotency_key,request_hash,account_revision,policy_revision,plan_hash,plan)
 VALUES(p_account,p_key,p_request,p_revision,p_policy,p_hash,p_plan) ON CONFLICT(account_id,idempotency_key) DO NOTHING;
 SELECT * INTO o FROM meta_ads_operations WHERE account_id=p_account AND idempotency_key=p_key;
 IF o.request_hash<>p_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
 RETURN to_jsonb(o);
END $$;
CREATE FUNCTION public.ads_operation_get(p_user uuid,p_account uuid,p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o meta_ads_operations; expired integer;
BEGIN
 PERFORM 1 FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE meta_ads_operations SET state='uncertain',result=jsonb_build_object('error','execution_interrupted'),updated_at=now()
 WHERE account_id=p_account AND state='executing' AND updated_at<now()-interval '2 minutes';
 GET DIAGNOSTICS expired = ROW_COUNT;
 IF expired>0 THEN UPDATE meta_ads_accounts SET revision=revision+1,updated_at=now() WHERE id=p_account; DELETE FROM meta_ads_cache WHERE account_id=p_account; END IF;
 SELECT * INTO o FROM meta_ads_operations WHERE account_id=p_account AND id=p_operation;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN to_jsonb(o);
END $$;
CREATE FUNCTION public.ads_operation_begin(p_user uuid,p_account uuid,p_operation uuid,p_hash text,p_confirm boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o meta_ads_operations; a meta_ads_accounts; p meta_ads_policy;
BEGIN
 SELECT * INTO a FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 SELECT * INTO p FROM meta_ads_policy WHERE account_id=p_account FOR UPDATE;
 SELECT * INTO o FROM meta_ads_operations WHERE id=p_operation AND account_id=p_account FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF o.plan_hash<>p_hash THEN RAISE EXCEPTION 'plan_hash_mismatch'; END IF;
 IF o.state<>'prepared' THEN RETURN jsonb_build_object('claimed',false,'operation',to_jsonb(o)); END IF;
 IF o.expires_at<now() THEN RAISE EXCEPTION 'plan_expired'; END IF;
 IF NOT a.enabled OR a.revision<>o.account_revision OR NOT coalesce(p.enabled,false) OR p.revision<>o.policy_revision THEN RAISE EXCEPTION 'ads_connection_changed'; END IF;
 IF (o.plan->>'requires_spend_confirmation')::boolean AND NOT p_confirm THEN RAISE EXCEPTION 'spend_confirmation_required'; END IF;
 IF EXISTS(SELECT 1 FROM meta_ads_operations WHERE account_id=p_account AND state='executing') THEN RAISE EXCEPTION 'operation_in_progress'; END IF;
 UPDATE meta_ads_operations SET state='executing',updated_at=now() WHERE id=o.id RETURNING * INTO o;
 RETURN jsonb_build_object('claimed',true,'operation',to_jsonb(o));
END $$;
CREATE FUNCTION public.ads_operation_finish(p_user uuid,p_account uuid,p_operation uuid,p_state text,p_result jsonb) RETURNS jsonb
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
 RETURN to_jsonb(o);
END $$;
-- Connection changes cannot race an operation between preflight and POST.
CREATE OR REPLACE FUNCTION public.ads_visible(p_row public.meta_ads_accounts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT (to_jsonb(p_row)-'user_id'-'access_token_encrypted') || jsonb_build_object('capabilities',jsonb_build_object('read',true,'manage',coalesce((SELECT enabled FROM meta_ads_policy WHERE account_id=p_row.id),false)));
$$;
CREATE OR REPLACE FUNCTION public.ads_context(p_user uuid,p_account uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT to_jsonb(a)||jsonb_build_object('management_enabled',coalesce((SELECT enabled FROM meta_ads_policy WHERE account_id=a.id),false)) FROM meta_ads_accounts a WHERE id=p_account AND user_id=p_user;
$$;
CREATE OR REPLACE FUNCTION public.ads_update(p_user uuid,p_account uuid,p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a meta_ads_accounts;
BEGIN
 SELECT * INTO a FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF EXISTS(SELECT 1 FROM meta_ads_operations WHERE account_id=p_account AND state='executing') THEN RAISE EXCEPTION 'operation_in_progress'; END IF;
 UPDATE meta_ads_accounts SET enabled=p_enabled,revision=revision+1,updated_at=now() WHERE id=p_account RETURNING * INTO a;
 DELETE FROM meta_ads_cache WHERE account_id=p_account;
 RETURN ads_visible(a);
END $$;
CREATE OR REPLACE FUNCTION public.ads_rotate(p_user uuid,p_account uuid,p_token text,p_metadata jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a meta_ads_accounts;
BEGIN
 SELECT * INTO a FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF EXISTS(SELECT 1 FROM meta_ads_operations WHERE account_id=p_account AND state='executing') THEN RAISE EXCEPTION 'operation_in_progress'; END IF;
 UPDATE meta_ads_accounts SET access_token_encrypted=p_token,metadata=p_metadata,revision=revision+1,verified_at=now(),updated_at=now() WHERE id=p_account RETURNING * INTO a;
 DELETE FROM meta_ads_cache WHERE account_id=p_account;
 RETURN ads_visible(a);
END $$;
CREATE OR REPLACE FUNCTION public.ads_connect(p_user uuid,p_meta_id text,p_token text,p_metadata jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a meta_ads_accounts;
BEGIN
 -- Serialize first-time connections as well as reconnects.
 PERFORM pg_advisory_xact_lock(hashtext(p_user::text||':'||p_meta_id));
 SELECT * INTO a FROM meta_ads_accounts WHERE user_id=p_user AND ad_account_id=p_meta_id FOR UPDATE;
 IF FOUND AND EXISTS(SELECT 1 FROM meta_ads_operations WHERE account_id=a.id AND state='executing') THEN RAISE EXCEPTION 'operation_in_progress'; END IF;
 INSERT INTO meta_ads_accounts(user_id,ad_account_id,access_token_encrypted,metadata) VALUES(p_user,p_meta_id,p_token,p_metadata)
 ON CONFLICT(user_id,ad_account_id) DO UPDATE SET access_token_encrypted=p_token,metadata=p_metadata,enabled=true,revision=meta_ads_accounts.revision+1,verified_at=now(),updated_at=now() RETURNING * INTO a;
 DELETE FROM meta_ads_cache WHERE account_id=a.id;
 RETURN ads_visible(a);
END $$;
CREATE FUNCTION public.ads_operations(p_user uuid,p_account uuid,p_before uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 WITH rows AS (SELECT o.* FROM meta_ads_operations o JOIN meta_ads_accounts a ON a.id=o.account_id
 WHERE a.id=p_account AND a.user_id=p_user AND (p_before IS NULL OR (o.created_at,o.id)<(SELECT created_at,id FROM meta_ads_operations WHERE id=p_before AND account_id=p_account))
 ORDER BY o.created_at DESC,o.id DESC LIMIT 51), page AS (SELECT * FROM rows ORDER BY created_at DESC,id DESC LIMIT 50)
 SELECT jsonb_build_object('data',coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb),
 'next_cursor',CASE WHEN (SELECT count(*) FROM rows)>50 THEN (SELECT id FROM page ORDER BY created_at,id LIMIT 1) ELSE NULL END);
$$;
REVOKE ALL ON FUNCTION public.ads_policy(uuid,uuid),public.ads_policy_set(uuid,uuid,boolean,text,text,text),
 public.ads_operation_find(uuid,uuid,text),public.ads_operation_prepare(uuid,uuid,text,text,bigint,bigint,text,jsonb),public.ads_operation_get(uuid,uuid,uuid),
 public.ads_operation_begin(uuid,uuid,uuid,text,boolean),public.ads_operation_finish(uuid,uuid,uuid,text,jsonb),public.ads_operations(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ads_policy(uuid,uuid),public.ads_policy_set(uuid,uuid,boolean,text,text,text),
 public.ads_operation_find(uuid,uuid,text),public.ads_operation_prepare(uuid,uuid,text,text,bigint,bigint,text,jsonb),public.ads_operation_get(uuid,uuid,uuid),
 public.ads_operation_begin(uuid,uuid,uuid,text,boolean),public.ads_operation_finish(uuid,uuid,uuid,text,jsonb),public.ads_operations(uuid,uuid,uuid) TO service_role;
