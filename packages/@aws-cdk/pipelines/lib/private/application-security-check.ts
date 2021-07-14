import * as path from 'path';
import * as codebuild from '@aws-cdk/aws-codebuild';
import * as iam from '@aws-cdk/aws-iam';
import * as lambda from '@aws-cdk/aws-lambda';
import { Duration } from '@aws-cdk/core';

// keep this import separate from other imports to reduce chance for merge conflicts with v2-main
// eslint-disable-next-line no-duplicate-imports, import/order
import { Construct } from '@aws-cdk/core';

/**
 * A construct containing both the Lambda and CodeBuild Project
 * needed to conduct a security check on any given application stage.
 *
 * The Lambda acts as an auto approving mechanism that should only be
 * triggered when the CodeBuild Project registers no security changes.
 *
 * The CodeBuild Project runs a security diff on the application stage,
 * and exports the link to the console of the project.
 */
export class ApplicationSecurityCheck extends Construct {
  /**
   * A lambda function that approves a Manual Approval Action, given
   * the following payload:
   *
   * {
   *  "PipelineName": [CodePipelineName],
   *  "StageName": [CodePipelineStageName],
   *  "ActionName": [ManualApprovalActionName]
   * }
   */
  public readonly preApproveLambda: lambda.Function;
  /**
   * A CodeBuild Project that runs a security diff on the application stage.
   *
   * - If the diff registers no security changes, CodeBuild will invoke the
   *   pre-approval lambda and approve the ManualApprovalAction.
   * - If changes are detected, CodeBuild will exit into a ManualApprovalAction
   */
  public readonly cdkDiffProject: codebuild.Project;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.preApproveLambda = new lambda.Function(this, 'CDKPipelinesAutoApprove', {
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_14_X,
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../lambda')),
      timeout: Duration.minutes(5),
    });

    this.preApproveLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codepipeline:GetPipelineState', 'codepipeline:PutApprovalResult'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/SECURITY_CHECK': 'ALLOW_APPROVE',
        },
      },
      resources: ['*'],
    }));

    const assemblyPath = 'assembly-$STACK_NAME-$STAGE_NAME/';
    const invokeLambda =
      'aws lambda invoke' +
      ` --function-name ${this.preApproveLambda.functionName}` +
      ' --invocation-type Event' +
      ' --payload "$payload"' +
      ' lambda.out';

    const message = [
      'Broadening IAM Permssions detected in $PIPELINE_NAME: $STAGE_NAME.',
      'You must manually approve the changes in CodePipeline to unblock the pipeline.',
      '',
      'See the security changes in the CodeBuild Logs',
      '===',
      '$LINK',
      '',
      'Approve changes in CodePipline',
      '===',
      '$PIPELINE_LINK',
    ];
    const publishNotification =
      'aws sns publish' +
      ' --topic-arn $NOTIFICATION_ARN' +
      ' --subject "$NOTIFICATION_SUBJECT"' +
      ` --message "${message.join('\n')}"`;

    this.cdkDiffProject = new codebuild.Project(this, 'CDKSecurityCheck', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: 0.2,
        phases: {
          build: {
            commands: [
              'npm install -g aws-cdk',
              // $CODEBUILD_INITIATOR will always be Code Pipeline and in the form of:
              // "codepipeline/example-pipeline-name-Xxx"
              'export PIPELINE_NAME="$(node -pe \'`${process.env.CODEBUILD_INITIATOR}`.split("/")[1]\')"',
              'payload="$(node -pe \'JSON.stringify({ "PipelineName": process.env.PIPELINE_NAME, "StageName": process.env.STAGE_NAME, "ActionName": process.env.ACTION_NAME })\' )"',
              // ARN: "arn:aws:codebuild:$region:$account_id:build/$project_name:$project_execution_id$"
              'ARN=$CODEBUILD_BUILD_ARN',
              'REGION="$(node -pe \'`${process.env.ARN}`.split(":")[3]\')"',
              'ACCOUNT_ID="$(node -pe \'`${process.env.ARN}`.split(":")[4]\')"',
              'PROJECT_NAME="$(node -pe \'`${process.env.ARN}`.split(":")[5].split("/")[1]\')"',
              'PROJECT_ID="$(node -pe \'`${process.env.ARN}`.split(":")[6]\')"',
              // Manual Approval adds 'http/https' to the resolved link
              'export LINK="$REGION.console.aws.amazon.com/codesuite/codebuild/$ACCOUNT_ID/projects/$PROJECT_NAME/build/$PROJECT_NAME:$PROJECT_ID/?region=$REGION"',
              'export PIPELINE_LINK=="$REGION.console.aws.amazon.com/codesuite/codepipeline/pipelines/$PIPELINE_NAME/view?region=$REGION"',
              // Run invoke only if cdk diff passes (returns exit code 0)
              // 0 -> true, 1 -> false
              ifElse({
                condition: `cdk diff -a "${assemblyPath}" --security-only --fail`,
                thenStatements: [
                  invokeLambda,
                  'export MESSAGE="No changes detected."',
                ],
                elseStatements: [
                  `[ -z "\${NOTIFICATION_ARN}" ] || ${publishNotification}`,
                  'export MESSAGE="Changes detected! Requires Manual Approval"',
                ],
              }),
            ],
          },
        },
        env: {
          'exported-variables': [
            'LINK',
            'MESSAGE',
          ],
        },
      }),
    });

    // this is needed to check the status the stacks when doing `cdk diff`
    this.cdkDiffProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: ['*'],
      conditions: {
        'ForAnyValue:StringEquals': {
          'iam:ResourceTag/aws-cdk:bootstrap-role': ['image-publishing', 'file-publishing', 'deploy'],
        },
      },
    }));

    this.preApproveLambda.grantInvoke(this.cdkDiffProject);
  }
}

interface ifElseOptions {
  readonly condition: string,
  readonly thenStatements: string[],
  readonly elseStatements?: string[]
}

const ifElse = ({ condition, thenStatements, elseStatements }: ifElseOptions): string => {
  let statement = thenStatements.reduce((acc, ifTrue) => {
    return `${acc} ${ifTrue};`;
  }, `if ${condition}; then`);

  if (elseStatements) {
    statement = elseStatements.reduce((acc, ifFalse) => {
      return `${acc} ${ifFalse};`;
    }, `${statement} else`);
  }

  return `${statement} fi`;
};