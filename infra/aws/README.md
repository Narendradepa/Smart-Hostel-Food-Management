# AWS deployment setup

The deployment workflow uses GitHub OIDC and AWS Systems Manager Run Command. It avoids opening SSH to GitHub-hosted runners and avoids storing a long-lived AWS key in GitHub.

## AWS resources

- Create the GitHub OIDC provider `token.actions.githubusercontent.com` with audience `sts.amazonaws.com` if the account does not already have it.
- Create the IAM role `SmartHostelGitHubDeployRole` with `github-actions-deploy-trust-policy.json` as its trust policy and `github-actions-deploy-permissions.json` as its permissions policy.
- Keep the EC2 instance role's existing `AmazonSSMManagedInstanceCore` policy. The instance must show as an Online managed node in Systems Manager before deployments can run.
- Keep the S3 bucket private with Block Public Access enabled. The workflow writes frontend files only under `frontend/`.

The trust policy is restricted to the `main` branch of `Narendradepa/Smart-Hostel-Food-Management`. Its permissions let the workflow publish frontend files to the bucket's `frontend/` prefix and run the deployment document on EC2 instance `i-00684a0067bf2306f`.

## Deployment behavior

On pushes to `main`, GitHub Actions installs and tests the backend, syncs the frontend to the private S3 prefix, then uses Systems Manager to fast-forward the EC2 checkout, install production dependencies, restart `hostel-food`, and require the service to be active.

The existing EC2-hosted HTTPS site remains the public website. The S3 copy is a private frontend mirror; this workflow does not make the bucket public or serve the site directly from S3.
