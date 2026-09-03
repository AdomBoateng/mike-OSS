# Kubernetes manifests

Plain kustomize, no Helm. The operational guide — what these need from outside
the cluster, and the handful of things that are not guessable from the YAML — is
[docs/KUBERNETES.md](../docs/KUBERNETES.md). Read that first.

```
base/                the application: config, backend, frontend, ingress
base/migrate/        the database migration Job, kept separate because it has to
                     finish BEFORE the Deployments roll
overlays/uat/        namespace mike-uat,  1 replica each
overlays/prod/       namespace mike-prod, 2 replicas each, PodDisruptionBudgets
searxng/             optional in-cluster SearXNG for the web-search tool
secret.example.yaml  TEMPLATE. The real Secret is created out of band; CI never
                     sees it.
```

Render without applying:

```bash
kubectl kustomize k8s/overlays/uat
```

Deploy by hand (CI does the same thing in `.gitlab-ci.yml`, in this order):

```bash
kubectl -n mike-uat delete job mike-migrate --ignore-not-found --wait=true
kubectl apply -k k8s/overlays/uat/migrate
kubectl -n mike-uat wait --for=condition=complete job/mike-migrate --timeout=600s
kubectl apply -k k8s/overlays/uat
```

Two placeholders are meant to be replaced before this is real: the hostnames in
each overlay's ingress patch, and the image names, which CI rewrites with
`kustomize edit set image`.
