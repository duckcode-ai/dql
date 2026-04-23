import type { NotificationIR } from '@duckcodeailabs/dql-compiler';
import type { Notifier, NotifierPayload } from '../types.js';
import { createEmailNotifier } from './email.js';
import { createFileNotifier } from './file.js';
import { createSlackNotifier } from './slack.js';

export interface NotificationDispatchResult {
  type: string;
  recipients: string[];
  delivered: boolean;
  error?: string;
}

export async function dispatchNotifications(
  notifications: NotificationIR[],
  payload: NotifierPayload,
  projectRoot: string,
): Promise<NotificationDispatchResult[]> {
  const notifiers: Record<string, Notifier> = {
    email: createEmailNotifier(),
    slack: createSlackNotifier(),
    file: createFileNotifier(projectRoot),
  };

  const out: NotificationDispatchResult[] = [];
  for (const n of notifications) {
    const notifier = notifiers[n.type];
    if (!notifier) {
      out.push({
        type: n.type,
        recipients: n.recipients,
        delivered: false,
        error: `no notifier registered for type "${n.type}"`,
      });
      continue;
    }
    const result = await notifier.send(n.recipients, payload);
    out.push({ type: n.type, recipients: n.recipients, ...result });
  }

  // Always append to file log for audit trail, even if no explicit file target.
  const fileLog = notifiers.file;
  const auditResult = await fileLog.send([], payload);
  if (auditResult.delivered || auditResult.error) {
    out.push({ type: 'file', recipients: ['.dql/runs/notifications.log'], ...auditResult });
  }

  return out;
}
