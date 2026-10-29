-- Keep safe provider diagnostics with the same fenced lifecycle write.
ALTER TABLE public.instagram_publications ADD COLUMN provider_error jsonb
 CHECK (provider_error IS NULL OR (jsonb_typeof(provider_error)='object'
 AND length(provider_error::text)<=8192));
ALTER FUNCTION public.publishing_finish(uuid,uuid,text,text,text,text,text,integer)
 RENAME TO publishing_finish_without_diagnostics;
CREATE FUNCTION public.publishing_finish(p_id uuid,p_token uuid,p_state text,
 p_container text DEFAULT NULL,p_media text DEFAULT NULL,p_permalink text DEFAULT NULL,
 p_error text DEFAULT NULL,p_delay integer DEFAULT 15,p_provider_error jsonb DEFAULT NULL)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE saved boolean;
BEGIN
 saved := publishing_finish_without_diagnostics(p_id,p_token,p_state,p_container,p_media,p_permalink,p_error,p_delay);
 IF saved THEN UPDATE instagram_publications SET provider_error=p_provider_error WHERE id=p_id; END IF;
 RETURN saved;
END $$;
REVOKE ALL ON FUNCTION public.publishing_finish(uuid,uuid,text,text,text,text,text,integer,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publishing_finish(uuid,uuid,text,text,text,text,text,integer,jsonb) TO service_role;
