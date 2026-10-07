-- Owner-only persistent optimization. No rules or spending limits are enabled by this migration.
CREATE TABLE public.meta_ads_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES public.meta_ads_accounts(id) ON DELETE CASCADE,
 config jsonb NOT NULL CHECK(octet_length(config::text)<16384), enabled boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1, next_run_at timestamptz NOT NULL DEFAULT now(),
 claim_token uuid, lease_until timestamptz, last_run_at timestamptz, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meta_ads_rules_due ON public.meta_ads_rules(next_run_at) WHERE enabled;
CREATE TABLE public.meta_ads_rule_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rule_id uuid NOT NULL REFERENCES public.meta_ads_rules(id) ON DELETE CASCADE,
 claim_token uuid NOT NULL, object_id text NOT NULL CHECK(object_id ~ '^[0-9]{1,30}$'),
 mode text NOT NULL CHECK(mode IN ('observe','execute')), outcome text NOT NULL,
 evidence jsonb NOT NULL CHECK(octet_length(evidence::text)<8192), operation_id uuid REFERENCES public.meta_ads_operations(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(rule_id,claim_token,object_id)
);
CREATE TABLE public.meta_ads_credential_health (
 account_id uuid PRIMARY KEY REFERENCES public.meta_ads_accounts(id) ON DELETE CASCADE,
 revision bigint NOT NULL, health jsonb NOT NULL CHECK(octet_length(health::text)<8192), checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.meta_ads_operations ADD COLUMN rule_id uuid REFERENCES public.meta_ads_rules(id), ADD COLUMN rule_revision bigint, ADD COLUMN rule_claim uuid;
ALTER TABLE public.meta_ads_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_rule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_credential_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_ads_rules,public.meta_ads_rule_runs,public.meta_ads_credential_health FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.meta_ads_rules,public.meta_ads_rule_runs,public.meta_ads_credential_health TO service_role;

CREATE FUNCTION public.ads_rules(p_user uuid,p_account uuid,p_before uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 WITH rows AS (SELECT r.* FROM meta_ads_rules r JOIN meta_ads_accounts a ON a.id=r.account_id WHERE a.id=p_account AND a.user_id=p_user AND (p_before IS NULL OR r.id>p_before) ORDER BY r.id LIMIT 51),
 page AS (SELECT * FROM rows ORDER BY id LIMIT 50)
 SELECT jsonb_build_object('data',coalesce((SELECT jsonb_agg(to_jsonb(page)-'claim_token'-'lease_until' ORDER BY id) FROM page),'[]'::jsonb),
 'next_cursor',CASE WHEN (SELECT count(*) FROM rows)>50 THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) ELSE NULL END);
$$;
CREATE FUNCTION public.ads_rule_set(p_user uuid,p_account uuid,p_rule uuid,p_config jsonb,p_authorized boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r meta_ads_rules;
BEGIN
 PERFORM 1 FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 IF (p_config->>'enabled')::boolean AND p_config->>'mode'='execute' AND NOT p_authorized THEN RAISE EXCEPTION 'automation_authorization_required'; END IF;
 IF (p_config->>'enabled')::boolean AND p_config->>'mode'='execute' AND NOT EXISTS(SELECT 1 FROM meta_ads_policy WHERE account_id=p_account AND enabled) THEN RAISE EXCEPTION 'ads_management_disabled'; END IF;
 IF p_rule IS NULL AND (SELECT count(*) FROM meta_ads_rules WHERE account_id=p_account)>=100 THEN RAISE EXCEPTION 'rule_limit'; END IF;
 IF p_rule IS NOT NULL THEN
  SELECT * INTO r FROM meta_ads_rules WHERE id=p_rule AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF EXISTS(SELECT 1 FROM meta_ads_operations WHERE rule_id=p_rule AND state='executing') THEN RAISE EXCEPTION 'operation_in_progress'; END IF;
  UPDATE meta_ads_rules SET config=p_config,enabled=(p_config->>'enabled')::boolean,revision=revision+1,next_run_at=now(),claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=p_rule RETURNING * INTO r;
 ELSE
  INSERT INTO meta_ads_rules(account_id,config,enabled) VALUES(p_account,p_config,(p_config->>'enabled')::boolean) RETURNING * INTO r;
 END IF;
 RETURN to_jsonb(r)-'claim_token'-'lease_until';
END $$;
CREATE FUNCTION public.ads_rule_claim(p_limit integer DEFAULT 2) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb;
BEGIN
 -- A crashed run with an ambiguous Meta outcome requires owner inspection; never reapply it automatically.
 UPDATE meta_ads_rules r SET enabled=false,last_error='automation_execution_uncertain',claim_token=NULL,lease_until=NULL
 WHERE enabled AND EXISTS(SELECT 1 FROM meta_ads_operations o WHERE o.rule_id=r.id AND (o.state='uncertain' OR (o.state='executing' AND o.updated_at<now()-interval '2 minutes')));
 WITH due AS (
  SELECT r.id FROM meta_ads_rules r JOIN meta_ads_accounts a ON a.id=r.account_id
  WHERE r.enabled AND a.enabled AND next_run_at<=now() AND (lease_until IS NULL OR lease_until<now())
  ORDER BY next_run_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT greatest(1,least(p_limit,4))
 ), claimed AS (
  UPDATE meta_ads_rules r SET claim_token=gen_random_uuid(),lease_until=now()+interval '6 minutes'
  FROM due WHERE r.id=due.id RETURNING r.*
 ) SELECT coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) INTO result FROM claimed;
 RETURN result;
END $$;
CREATE FUNCTION public.ads_rule_context(p_rule uuid,p_claim uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT to_jsonb(r)||jsonb_build_object('owner_id',a.user_id) FROM meta_ads_rules r JOIN meta_ads_accounts a ON a.id=r.account_id
 WHERE r.id=p_rule AND r.claim_token=p_claim AND r.enabled AND a.enabled AND r.lease_until>now();
$$;
CREATE FUNCTION public.ads_rule_record(p_rule uuid,p_claim uuid,p_object text,p_mode text,p_outcome text,p_evidence jsonb,p_operation uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r meta_ads_rules; o meta_ads_operations; v meta_ads_rule_runs; quota integer;
BEGIN
 SELECT r0.* INTO r FROM meta_ads_rules r0 JOIN meta_ads_accounts a ON a.id=r0.account_id WHERE r0.id=p_rule AND r0.claim_token=p_claim AND r0.enabled AND a.enabled AND r0.lease_until>now()+interval '60 seconds' FOR UPDATE OF a,r0;
 IF NOT FOUND THEN RAISE EXCEPTION 'automation_cancelled'; END IF;
 IF p_mode<>r.config->>'mode' OR NOT (r.config->'object_ids') ? p_object THEN RAISE EXCEPTION 'automation_cancelled'; END IF;
 IF p_operation IS NOT NULL THEN
  SELECT * INTO o FROM meta_ads_operations WHERE id=p_operation AND account_id=r.account_id AND state='prepared' FOR UPDATE;
  IF NOT FOUND OR p_mode<>'execute' THEN RAISE EXCEPTION 'automation_cancelled'; END IF;
  -- Cooldown spans rule edits; count all reserved writes, including ambiguous/failed writes.
  IF EXISTS(SELECT 1 FROM meta_ads_rule_runs WHERE rule_id=r.id AND object_id=p_object AND operation_id IS NOT NULL AND created_at>now()-make_interval(secs=>(r.config->>'cooldown_seconds')::integer)) THEN
   UPDATE meta_ads_operations SET state='cancelled',result=jsonb_build_object('error','automation_cooldown'),updated_at=now() WHERE id=p_operation; RETURN NULL;
  END IF;
  SELECT count(*) INTO quota FROM meta_ads_rule_runs WHERE rule_id=r.id AND operation_id IS NOT NULL AND created_at>now()-interval '24 hours';
  IF quota>=(r.config->>'max_changes_per_day')::integer THEN
   UPDATE meta_ads_operations SET state='cancelled',result=jsonb_build_object('error','automation_day_quota'),updated_at=now() WHERE id=p_operation; RETURN NULL;
  END IF;
  UPDATE meta_ads_operations SET rule_id=r.id,rule_revision=r.revision,rule_claim=p_claim WHERE id=p_operation;
 END IF;
 INSERT INTO meta_ads_rule_runs(rule_id,claim_token,object_id,mode,outcome,evidence,operation_id)
 VALUES(p_rule,p_claim,p_object,p_mode,p_outcome,p_evidence,p_operation) ON CONFLICT(rule_id,claim_token,object_id) DO NOTHING RETURNING * INTO v;
 RETURN to_jsonb(v);
END $$;
CREATE FUNCTION public.ads_rule_result(p_rule uuid,p_claim uuid,p_object text,p_outcome text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 UPDATE meta_ads_rule_runs SET outcome=p_outcome WHERE rule_id=p_rule AND claim_token=p_claim AND object_id=p_object;
$$;
CREATE FUNCTION public.ads_rule_finish(p_rule uuid,p_claim uuid,p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 UPDATE meta_ads_rules SET claim_token=NULL,lease_until=NULL,last_run_at=now(),last_error=p_error,
 enabled=CASE WHEN p_error='automation_execution_uncertain' THEN false ELSE enabled END,
 next_run_at=now()+make_interval(secs=>(config->>'interval_seconds')::integer),updated_at=now()
 WHERE id=p_rule AND claim_token=p_claim;
$$;
CREATE FUNCTION public.ads_rule_runs(p_user uuid,p_account uuid,p_rule uuid,p_before uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 WITH rows AS (SELECT v.* FROM meta_ads_rule_runs v JOIN meta_ads_rules r ON r.id=v.rule_id JOIN meta_ads_accounts a ON a.id=r.account_id
 WHERE a.id=p_account AND a.user_id=p_user AND r.id=p_rule AND (p_before IS NULL OR (v.created_at,v.id)<(SELECT created_at,id FROM meta_ads_rule_runs WHERE id=p_before AND rule_id=p_rule))
 ORDER BY v.created_at DESC,v.id DESC LIMIT 51), page AS (SELECT * FROM rows ORDER BY created_at DESC,id DESC LIMIT 50)
 SELECT jsonb_build_object('data',coalesce((SELECT jsonb_agg(to_jsonb(page)-'claim_token' ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb),
 'next_cursor',CASE WHEN (SELECT count(*) FROM rows)>50 THEN (SELECT id FROM page ORDER BY created_at,id LIMIT 1) ELSE NULL END);
$$;
-- Preserve the original account/policy/idempotency checks, adding a rule revision/lease check under the same account lock.
ALTER FUNCTION public.ads_operation_begin(uuid,uuid,uuid,text,boolean) RENAME TO ads_operation_begin_core;
CREATE FUNCTION public.ads_operation_begin(p_user uuid,p_account uuid,p_operation uuid,p_hash text,p_confirm boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o meta_ads_operations; r meta_ads_rules;
BEGIN
 PERFORM 1 FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 SELECT * INTO o FROM meta_ads_operations WHERE id=p_operation AND account_id=p_account;
 IF o.state='prepared' AND o.rule_id IS NOT NULL THEN
  SELECT * INTO r FROM meta_ads_rules WHERE id=o.rule_id FOR UPDATE;
  IF NOT r.enabled OR r.revision<>o.rule_revision OR r.claim_token IS DISTINCT FROM o.rule_claim OR r.lease_until<=now() OR r.config->>'mode'<>'execute' THEN RAISE EXCEPTION 'automation_cancelled'; END IF;
 END IF;
 RETURN ads_operation_begin_core(p_user,p_account,p_operation,p_hash,p_confirm);
END $$;
CREATE FUNCTION public.ads_credential_health_set(p_user uuid,p_account uuid,p_revision bigint,p_health jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM 1 FROM meta_ads_accounts WHERE id=p_account AND user_id=p_user AND revision=p_revision FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO meta_ads_credential_health(account_id,revision,health) VALUES(p_account,p_revision,p_health)
 ON CONFLICT(account_id) DO UPDATE SET revision=p_revision,health=p_health,checked_at=now();
 RETURN true;
END $$;
CREATE FUNCTION public.ads_credential_health_get(p_user uuid,p_account uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT to_jsonb(h)-'account_id'-'revision' FROM meta_ads_credential_health h JOIN meta_ads_accounts a ON a.id=h.account_id
 WHERE a.id=p_account AND a.user_id=p_user AND a.revision=h.revision;
$$;
CREATE FUNCTION public.ads_credential_health_due() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (
 SELECT a.id,a.user_id FROM meta_ads_accounts a LEFT JOIN meta_ads_credential_health h ON h.account_id=a.id
 WHERE a.enabled AND (h.account_id IS NULL OR h.revision<>a.revision OR h.checked_at<now()-interval '1 day') ORDER BY h.checked_at NULLS FIRST,a.id LIMIT 4) x;
$$;
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'ads_rule%' OR p.proname LIKE 'ads_credential_health%' OR p.proname IN ('ads_operation_begin','ads_operation_begin_core')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
