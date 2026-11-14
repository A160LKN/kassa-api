import { randomUUID } from 'node:crypto';
import { signWebhook } from '../lib/security.js';

export interface PaymentRequest {
  orderId: string;
  amount: number;
  cardToken: string;
}

/** Платёжный сервис: создать платёж и вернуть деньги. Результат оплаты приходит позже — вебхуком. */
export interface PaymentGateway {
  createPayment(request: PaymentRequest): Promise<{ paymentId: string }>;
  refund(paymentId: string, amount: number): Promise<void>;
}

export interface WebhookPayload {
  event_id: string;
  type: 'payment.succeeded' | 'payment.failed';
  payment_id: string;
  order_id: string;
  amount: number;
  reason?: string;
}

/** Тестовые карты учебного шлюза: как у настоящих платёжных сервисов в режиме песочницы. */
export const TEST_CARDS = {
  tok_success: 'Оплата пройдёт',
  tok_declined: 'Банк отклонит: недостаточно средств',
} as const;

/**
 * Учебный шлюз для живого демо: принимает платёж и через мгновение присылает подписанный вебхук
 * на WEBHOOK_URL — по HTTP, как настоящий сервис. Подпись тем же секретом, что проверяет API.
 */
export class SandboxGateway implements PaymentGateway {
  readonly refunds: { paymentId: string; amount: number }[] = [];

  constructor(
    private readonly webhookUrl: string,
    private readonly secret: string,
    private readonly delayMs = 800,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  createPayment({ orderId, amount, cardToken }: PaymentRequest): Promise<{ paymentId: string }> {
    const paymentId = `pay_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const succeeded = cardToken === 'tok_success';
    const payload: WebhookPayload = {
      event_id: `evt_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      type: succeeded ? 'payment.succeeded' : 'payment.failed',
      payment_id: paymentId,
      order_id: orderId,
      amount,
      ...(succeeded ? {} : { reason: TEST_CARDS.tok_declined }),
    };
    setTimeout(() => void this.deliver(payload), this.delayMs).unref();
    return Promise.resolve({ paymentId });
  }

  refund(paymentId: string, amount: number): Promise<void> {
    this.refunds.push({ paymentId, amount });
    return Promise.resolve();
  }

  private async deliver(payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': signWebhook(body, this.secret) },
        body,
      });
      this.log(`Учебный шлюз: вебхук ${payload.type} → ${response.status}`);
    } catch (error) {
      this.log(`Учебный шлюз: вебхук не доставлен — ${String(error)}`);
    }
  }
}
