# AWS deployment setup

The deployment workflow uses GitHub OIDC and AWS Systems Manager Run Command. It avoids opening SSH to GitHub-hosted runners and avoids storing a long-lived AWS key in GitHub.

## AWS resources

- Create the GitHub OIDC provider `token.actions.githubusercontent.com` with audience `sts.amazonaws.com` if the account does not already have it.
- Create the IAM role `SmartHostelGitHubDeployRole` with `github-actions-deploy-trust-policy.json` as its trust policy and `github-actions-deploy-permissions.json` as its permissions policy.
- The EC2 instance must show as an Online managed node in Systems Manager before deployments can run. The DynamoDB stack below creates the app instance role with `AmazonSSMManagedInstanceCore`.
- Keep the S3 bucket private with Block Public Access enabled. The workflow writes frontend files only under `frontend/`.

The trust policy is restricted to the `main` branch of `Narendradepa/Smart-Hostel-Food-Management`. Its permissions let the workflow publish frontend files to the bucket's `frontend/` prefix and run the deployment document on EC2 instance `i-00684a0067bf2306f`.

## Deployment behavior

On pushes to `main`, GitHub Actions installs and tests the backend, syncs the frontend to the private S3 prefix, then uses Systems Manager to fast-forward the EC2 checkout, install production dependencies, restart `hostel-food`, and require the service to be active.

The existing EC2-hosted HTTPS site remains the public website. The S3 copy is a private frontend mirror; this workflow does not make the bucket public or serve the site directly from S3.

## DynamoDB application storage

The application can use either its existing local SQLite database or DynamoDB. Local development remains SQLite by default. Production switches to DynamoDB only when the deployment workflow is manually run with `storage_backend=dynamodb`.

The CloudFormation template `dynamodb-stack.json` creates these seven project tables in the selected AWS region:

| Table | Website data |
|---|---|
| `SmartHostelFoodManagement-FoodRequests` | Student food requests and their statuses |
| `SmartHostelFoodManagement-Menus` | Daily breakfast, lunch, and dinner |
| `SmartHostelFoodManagement-FoodPreferences` | Student diet and spice preferences |
| `SmartHostelFoodManagement-Feedback` | Student feedback and acknowledgement status |
| `SmartHostelFoodManagement-Complaints` | Complaints and their progress status |
| `SmartHostelFoodManagement-StaffRatings` | Staff ratings and comments |
| `SmartHostelFoodManagement-Notifications` | Student and kitchen notifications |

Tables use on-demand billing, deletion protection, and a retain policy. The stack also creates an EC2 role and instance profile with Systems Manager access, CloudWatch Agent access, and DynamoDB read/write access scoped to these project tables. It does not grant the website client direct DynamoDB credentials; the Node.js backend uses the EC2 role.

### Provision and switch production

1. In the AWS Console, open **CloudFormation** in `us-east-1` and choose **Create stack → With new resources (standard)**.
2. Upload `infra/aws/dynamodb-stack.json`. Keep the default table prefix and use stack name `smart-hostel-food-management-dynamodb`. CloudFormation will create seven tables, an EC2 role, and an instance profile. Review and acknowledge the IAM resource creation on the final stack page.
3. Wait until stack status is `CREATE_COMPLETE`. In EC2, select `i-00684a0067bf2306f` and choose **Actions → Security → Modify IAM role**. Select `SmartHostelFoodManagement-EC2Profile` and save. Wait for the instance to appear Online in Systems Manager; the app needs this profile for temporary AWS credentials, and deployment uses SSM.
4. Publish the updated project files to `main`. In GitHub, open **Actions → Deploy Smart Hostel Food Management → Run workflow**. Choose branch `main` and `dynamodb` for `storage_backend`. The workflow writes persistent systemd environment settings and restarts the application through SSM.
5. Open **DynamoDB → Tables** in `us-east-1`. Submit a normal food request, preference, feedback, complaint, or rating through the website; the corresponding table should receive a new item.

The app does not copy old SQLite rows into DynamoDB. Existing rows remain in the EC2 SQLite file; records submitted after the DynamoDB deployment go to DynamoDB. The backend's admin listing/report endpoints continue to work against the selected storage backend.

### Permissions required to create the stack

The person creating the CloudFormation stack needs permission to create the seven DynamoDB tables, EC2 role, and instance profile, and to attach the profile to the project instance. The tables use on-demand billing, so AWS charges for stored data and requests. The application role itself receives only `GetItem`, `PutItem`, `UpdateItem`, `Scan`, and `Query` on the project tables and the Notifications index. It does not receive table deletion or table-creation permissions.
