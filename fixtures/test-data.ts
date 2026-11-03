import { randomUUID } from 'node:crypto';
export const uniqueSuffix = () => randomUUID().slice(0, 8);
export const uniqueEmail = (prefix = 'qa') => `${prefix}+${uniqueSuffix()}@testenv.local`;
export const uniqueName = (prefix = 'QA') => `${prefix} ${uniqueSuffix()}`;
