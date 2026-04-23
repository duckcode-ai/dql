import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Notifier, NotifierPayload } from '../types.js';

export function createFileNotifier(projectRoot: string): Notifier {
  return {
    type: 'file',
    async send(recipients, payload) {
      const targets = recipients.length > 0 ? recipients : ['.dql/runs/notifications.log'];
      try {
        for (const target of targets) {
          const abs = isAbsolute(target) ? target : join(projectRoot, target);
          const dir = dirname(abs);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          appendFileSync(abs, formatLine(payload) + '\n', 'utf-8');
        }
        return { delivered: true };
      } catch (err) {
        return { delivered: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function formatLine(payload: NotifierPayload): string {
  const breached = payload.alerts.filter((a) => a.breached).length;
  return JSON.stringify({
    time: payload.startedAt,
    block: payload.block,
    trigger: payload.trigger,
    breached,
    alerts: payload.alerts.map((a) => ({
      condition: a.alert.conditionSQL,
      operator: a.alert.operator,
      threshold: a.alert.threshold,
      observed: a.observedValue,
      breached: a.breached,
      message: a.alert.message,
    })),
  });
}
