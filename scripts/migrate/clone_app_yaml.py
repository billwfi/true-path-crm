"""Build a Container App YAML that clones ca-tpcrm-prod's containers (image + env +
resources) AND its secrets into the VNet/NAT environment, with external ingress and
ACR admin-cred pull. Used by .github/workflows/migrate-web-to-nat.yml. Values stay in
the runner; nothing sensitive is printed.

Usage: clone_app_yaml.py <env_id> <location> <acr_user> <acr_pw> <containers.json> <secrets.json> <out.yaml>
"""
import json
import sys

import yaml

env_id, loc, acr_user, acr_pw, containers_path, secrets_path, out_path = sys.argv[1:8]
containers = json.load(open(containers_path))

# Source app secrets (name/value) + the ACR pull password we add.
secrets = []
try:
    for s in json.load(open(secrets_path)):
        if s.get("name") and "value" in s:
            secrets.append({"name": s["name"], "value": s["value"]})
except (FileNotFoundError, json.JSONDecodeError):
    pass
secrets.append({"name": "acr-pw", "value": acr_pw})

doc = {
    "name": "ca-tpcrm-web",
    "type": "Microsoft.App/containerApps",
    "location": loc,
    "identity": {"type": "SystemAssigned"},
    "properties": {
        "environmentId": env_id,
        "configuration": {
            "activeRevisionsMode": "Single",
            "ingress": {"external": True, "targetPort": 8080, "transport": "auto", "allowInsecure": False},
            "registries": [{"server": "acrtpcrm.azurecr.io", "username": acr_user, "passwordSecretRef": "acr-pw"}],
            "secrets": secrets,
        },
        "template": {
            "containers": containers,
            "scale": {"minReplicas": 1, "maxReplicas": 3},
        },
    },
}
yaml.safe_dump(doc, open(out_path, "w"), sort_keys=False)
print(f"built {out_path}: image {containers[0]['image']}, "
      f"{len(containers[0].get('env', []))} env vars, {len(secrets)} secrets")
