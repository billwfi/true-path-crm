"""Build a Container App YAML that clones ca-tpcrm-prod's containers (image + env +
resources) into the VNet/NAT environment, with external ingress and ACR admin-cred
pull. Used by .github/workflows/migrate-web-to-nat.yml. Values stay in the runner;
nothing is printed.

Usage: clone_app_yaml.py <env_id> <location> <acr_user> <acr_pw> <containers.json> <out.yaml>
"""
import json
import sys

import yaml

env_id, loc, acr_user, acr_pw, containers_path, out_path = sys.argv[1:7]
containers = json.load(open(containers_path))

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
            "secrets": [{"name": "acr-pw", "value": acr_pw}],
        },
        "template": {
            "containers": containers,
            "scale": {"minReplicas": 1, "maxReplicas": 3},
        },
    },
}
yaml.safe_dump(doc, open(out_path, "w"), sort_keys=False)
print(f"built {out_path}: image {containers[0]['image']}, {len(containers[0].get('env', []))} env vars")
