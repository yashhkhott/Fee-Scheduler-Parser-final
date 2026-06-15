import 'dotenv/config';
import { ServiceBusClient, ServiceBusSender, ServiceBusReceiver } from '@azure/service-bus';
import { enqueueJob } from './queue.js';

const connStr = process.env.AZURE_SERVICEBUS_CONNECTION_STRING || '';
const queueName = 'parse-jobs';

let sbClient: ServiceBusClient | null = null;
let sender: ServiceBusSender | null = null;
let useCloudQueue = false;

if (connStr && connStr !== 'your_servicebus_connection_string_here') {
  try {
    sbClient = new ServiceBusClient(connStr);
    sender = sbClient.createSender(queueName);
    useCloudQueue = true;
    console.log('\x1b[32m[QUEUE] Connected to Azure Service Bus successfully.\x1b[0m');
  } catch (err: any) {
    console.error('[QUEUE ERROR] Failed to connect to Azure Service Bus:', err.message);
  }
}

if (!useCloudQueue) {
  console.log('\x1b[33m[QUEUE] ⚠️ Running in LOCAL QUEUE mode. Jobs are enqueued in-memory.\x1b[0m');
}

/**
 * Enqueues a parse job ID into the messaging pipeline.
 */
export async function pushToQueue(jobId: string): Promise<void> {
  if (useCloudQueue && sender) {
    console.log(`[QUEUE] Enqueuing Job ${jobId} to Azure Service Bus...`);
    await sender.sendMessages({
      body: { jobId },
      contentType: 'application/json'
    });
    return;
  }

  // Local fallback: Trigger queue runner directly
  console.log(`[QUEUE] Enqueuing Job ${jobId} locally...`);
  enqueueJob(jobId);
}

/**
 * Starts receiving messages from the cloud queue (if in Azure mode).
 * In local mode, the queue runs immediately synchronously.
 */
export function startQueueConsumer(): void {
  if (!useCloudQueue || !sbClient) return;

  const receiver = sbClient.createReceiver(queueName);
  console.log('[QUEUE] Starting Azure Service Bus message consumer...');

  receiver.subscribe({
    processMessage: async (message) => {
      const body = message.body as { jobId: string };
      console.log(`[QUEUE] Received job message from Service Bus: ${body.jobId}`);
      
      // Execute the job runner logic
      await new Promise<void>((resolve, reject) => {
        try {
          enqueueJob(body.jobId);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    },
    processError: async (args) => {
      console.error('[QUEUE ERROR] Error processing Service Bus message:', args.error);
    }
  });
}
