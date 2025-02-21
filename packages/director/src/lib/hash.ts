import { PlatformData } from '@sorry-cypress/common';
import md5 from 'md5';
import uuid from 'uuid/v4';

export const generateRunIdHash = (
  ciBuildId: string,
  message: string,
  projectId: string
) => {
  return md5(ciBuildId + message + projectId);
};

// not sure how specific that should be
export const generateGroupId = (
  platform: PlatformData,
  ciBuildId: string
): string => `${ciBuildId}`;

export const generateUUID = () => uuid();
