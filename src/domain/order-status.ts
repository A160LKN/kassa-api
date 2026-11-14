/**
 * Конечный автомат заказа. Все переходы — только через next(): «оплатить отменённый» или
 * «вернуть деньги за неоплаченный» невозможно даже по ошибке в коде.
 *
 *   pending_payment ──pay──▶ paid ──refund──▶ refunded
 *        │  └──cancel──▶ cancelled
 *        └──expire──▶ expired ──late_payment──▶ refunded   (оплата пришла после истечения — деньги вернуть)
 */
export type OrderStatus = 'pending_payment' | 'paid' | 'expired' | 'cancelled' | 'refunded';
export type OrderAction = 'pay' | 'cancel' | 'expire' | 'refund' | 'late_payment';

const TRANSITIONS: Record<OrderStatus, Partial<Record<OrderAction, OrderStatus>>> = {
  pending_payment: { pay: 'paid', cancel: 'cancelled', expire: 'expired' },
  paid: { refund: 'refunded' },
  expired: { late_payment: 'refunded' },
  cancelled: {},
  refunded: {},
};

export const STATUSES = Object.keys(TRANSITIONS) as OrderStatus[];
export const ACTIONS: OrderAction[] = ['pay', 'cancel', 'expire', 'refund', 'late_payment'];

export class TransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly action: OrderAction,
  ) {
    super(`Действие «${action}» недоступно для заказа в статусе «${from}»`);
  }
}

export function next(from: OrderStatus, action: OrderAction): OrderStatus {
  const to = TRANSITIONS[from][action];
  if (!to) throw new TransitionError(from, action);
  return to;
}

export const isFinal = (status: OrderStatus) => Object.keys(TRANSITIONS[status]).length === 0;
