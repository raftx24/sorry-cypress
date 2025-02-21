import {
  CreateRunResponse,
  CreateRunWarning,
  getCreateProjectValue,
  isRunCompleted,
  Run,
  Task,
} from '@sorry-cypress/common';
import { INACTIVITY_TIMEOUT_SECONDS } from '@sorry-cypress/director/config';
import { getRunCiBuildId } from '@sorry-cypress/director/lib/ciBuildId';
import {
  AppError,
  CLAIM_FAILED,
  RUN_EXISTS,
  RUN_NOT_EXIST,
} from '@sorry-cypress/director/lib/errors';
import {
  generateGroupId,
  generateRunIdHash,
  generateUUID,
} from '@sorry-cypress/director/lib/hash';
import { getDashboardRunURL } from '@sorry-cypress/director/lib/urls';
import { ExecutionDriver } from '@sorry-cypress/director/types';
import { getLogger } from '@sorry-cypress/logger';
import { runTimeoutModel } from '@sorry-cypress/mongo';
import { addSeconds } from 'date-fns';
import { curry, property, uniq } from 'lodash';
import {
  enhanceSpec,
  getClaimedSpecs,
  getFirstUnclaimedSpec,
  getNewSpecsInGroup,
  getSpecsForGroup,
} from '../../utils';
import { createInstance } from '../instances/instance.controller';
import { createProject, getProjectById } from './../projects/project.model';
import {
  addNewGroupToRun,
  createRun as storageCreateRun,
  getNewGroupTemplate,
  getRunById,
  setRunCompleted,
  setSpecClaimed,
  setSpecCompleted,
} from './run.model';
export const getById = getRunById;

export const createRun: ExecutionDriver['createRun'] = async (params) => {
  const ciBuildId = getRunCiBuildId(params);

  const runId = generateRunIdHash(
    ciBuildId,
    params.commit.message ?? params.commit.sha,
    params.projectId
  );

  const groupId = params.group ?? generateGroupId(params.platform, ciBuildId);

  const machineId = generateUUID();
  const enhaceSpecForThisRun = enhanceSpec(groupId);

  const response: CreateRunResponse = {
    groupId,
    machineId,
    runId,
    runUrl: getDashboardRunURL(runId),
    isNewRun: true,
    warnings: [] as CreateRunWarning[],
  };

  try {
    let project = await getProjectById(params.projectId);
    if (!project) {
      project = await createProject(
        getCreateProjectValue(params.projectId, INACTIVITY_TIMEOUT_SECONDS)
      );
    }
    const specs = params.specs.map(enhaceSpecForThisRun);

    await storageCreateRun({
      runId,
      cypressVersion: params.cypressVersion,
      createdAt: new Date().toISOString(),
      completion: {
        completed: false,
      },
      meta: {
        ciBuildId,
        commit: params.commit,
        projectId: params.projectId,
        platform: params.platform,
        ci: params.ci,
      },
      progress: {
        updatedAt: new Date(),
        groups: [getNewGroupTemplate(groupId, specs.length)],
      },
      specs,
    });
    const timeoutSeconds =
      project?.inactivityTimeoutSeconds ?? INACTIVITY_TIMEOUT_SECONDS;
    await runTimeoutModel.createRunTimeout({
      runId,
      timeoutSeconds,
      timeoutAfter: addSeconds(new Date(), timeoutSeconds),
    });

    return response;
  } catch (error) {
    if (error.code && error.code === RUN_EXISTS) {
      response.isNewRun = false;

      // serverless: prone to race condition on serverless
      const run = await getRunById(runId);
      if (!run) {
        throw new Error('No run found');
      }
      const newSpecs = getNewSpecsInGroup({
        run,
        groupId,
        candidateSpecs: params.specs,
      });

      if (!newSpecs.length) {
        return response;
      }

      // if the same group has different specs - no-no-no!
      const existingGroupSpecs = getSpecsForGroup(run, groupId);
      if (newSpecs.length && existingGroupSpecs.length) {
        response.warnings?.push({
          message: `Group ${groupId} has different specs for the same run.`,
          originalSpecs: existingGroupSpecs.map((spec) => spec.spec).join(', '),
          newSpecs: newSpecs.join(','),
        });
        return response;
      }

      await addNewGroupToRun(
        runId,
        groupId,
        newSpecs.map(enhaceSpecForThisRun)
      );

      return response;
    }
    throw error;
  }
};

export const getNextTask: ExecutionDriver['getNextTask'] = async ({
  runId,
  groupId,
  machineId,
  cypressVersion,
}): Promise<Task> => {
  getLogger().log(
    { runId, groupId, machineId, cypressVersion },
    'Getting the next unclaimed spec'
  );
  const run = await getById(runId);
  if (!run) {
    getLogger().error(
      { runId, groupId, machineId, cypressVersion },
      'Run not found'
    );
    throw new AppError(RUN_NOT_EXIST);
  }

  // all specs claimed
  const spec = getFirstUnclaimedSpec(run, groupId);

  if (!spec) {
    getLogger().log(
      { runId, groupId, machineId, cypressVersion },
      'No more unclaimed specs'
    );
    return {
      instance: null,
      claimedInstances: getClaimedSpecs(run, runId).length,
      totalInstances: getSpecsForGroup(run, groupId).length,
      projectId: run.meta.projectId,
    };
  }

  getLogger().log(
    { runId, groupId, machineId, cypressVersion, spec },
    'Received unclaimed spec, setting spec as claimed'
  );

  try {
    await setSpecClaimed(runId, groupId, spec.instanceId, machineId);
    await createInstance({
      runId,
      projectId: run.meta.projectId,
      instanceId: spec.instanceId,
      groupId,
      spec: spec.spec,
      cypressVersion,
    });
    return {
      instance: spec,
      claimedInstances: getClaimedSpecs(run, groupId).length + 1,
      totalInstances: getSpecsForGroup(run, groupId).length,
      projectId: run.meta.projectId,
    };
  } catch (error) {
    if (error.code && error.code === CLAIM_FAILED) {
      getLogger().log(
        { runId, groupId, machineId, spec },
        'The spec is already claimed, tring a different spec'
      );
      // just try to get next available spec
      return await getNextTask({ runId, machineId, groupId, cypressVersion });
    }

    getLogger().error(
      { runId, groupId, machineId, spec },
      'Unexpected error while claiming a spec'
    );
    throw error;
  }
};

export const updateRunSpecCompleted = setSpecCompleted;

export const allRunSpecsCompleted = async (runId: string): Promise<boolean> => {
  const run = await getById(runId);
  if (!run) {
    throw new AppError(RUN_NOT_EXIST);
  }
  if (!run.progress) {
    return false;
  }
  return isRunCompleted(run.progress);
};

export const getNonCompletedGroups = (run: Run) => {
  const groups: string[] = uniq(run.specs.map(property('groupId')));
  return groups.filter(curry(hasIncompletedGroupSpecs)(run));
};

export const allGroupSpecsCompleted: ExecutionDriver['allGroupSpecsCompleted'] = async (
  runId,
  groupId
) => {
  const run = await getById(runId);
  if (!run) {
    throw new AppError(RUN_NOT_EXIST);
  }
  return !hasIncompletedGroupSpecs(run, groupId);
};

export const maybeSetRunCompleted = async (runId: string) => {
  if (await allRunSpecsCompleted(runId)) {
    getLogger().log({ runId }, `[run-completion] Run completed`);
    setRunCompleted(runId).catch(getLogger().error);
    return true;
  }
  // timeout should handle
  return false;
};

const hasIncompletedGroupSpecs = (run: Run, groupId: string) =>
  run.specs.some((s) => s.groupId === groupId && !s.completedAt);
