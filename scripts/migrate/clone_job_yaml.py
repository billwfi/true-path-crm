"""Build a Container Apps JOB YAML that clones an existing scheduled job into the
VNet/NAT environment (cae-tpcrm-jobs), preserving its Schedule trigger/cron, image,
env (values + secretRefs), resources, and secrets — with ACR admin-cred pull. Used
by .github/workflows/migrate-job-to-nat.yml. Secret values stay in the runner.

Usage: clone_job_yaml.py <env_id> <acr_user> <acr_pw> <source_job.json> <secrets.json> <out.yaml>
"""
import json
import sys

import yaml

env_id, acr_user, acr_pw, src_path, secrets_path, out_path = sys.argv[1:7]
src = json.load(open(src_path))
props = src["properties"]
cfg = props["configuration"]
tmpl = props["template"]

secrets = []
try:
    for s in json.load(open(secrets_path)):
        if s.get("name") and "value" in s:
            secrets.append({"name": s["name"], "value": s["value"]})
except (FileNotFoundError, json.JSONDecodeError):
    pass
secrets.append({"name": "acr-pw", "value": acr_pw})

configuration = {
    "triggerType": cfg.get("triggerType", "Schedule"),
    "replicaTimeout": cfg.get("replicaTimeout", 1800),
    "replicaRetryLimit": cfg.get("replicaRetryLimit", 0),
    "registries": [{"server": "acrtpcrm.azurecr.io", "username": acr_user, "passwordSecretRef": "acr-pw"}],
    "secrets": secrets,
}
if cfg.get("scheduleTriggerConfig"):
    st = cfg["scheduleTriggerConfig"]
    configuration["scheduleTriggerConfig"] = {
        "cronExpression": st["cronExpression"],
        "parallelism": st.get("parallelism", 1),
        "replicaCompletionCount": st.get("replicaCompletionCount", 1),
    }

doc = {
    "name": src["name"],
    "type": "Microsoft.App/jobs",
    "location": src["location"],
    "identity": {"type": "SystemAssigned"},
    "properties": {
        "environmentId": env_id,
        "configuration": configuration,
        "template": {"containers": tmpl["containers"]},
    },
}
yaml.safe_dump(doc, open(out_path, "w"), sort_keys=False)
print(f"built {out_path}: {src['name']} image={tmpl['containers'][0]['image']} "
      f"cron={configuration.get('scheduleTriggerConfig', {}).get('cronExpression', 'n/a')} "
      f"env_vars={len(tmpl['containers'][0].get('env', []))} secrets={len(secrets)}")
