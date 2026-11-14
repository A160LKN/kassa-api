import fc from 'fast-check';
import {
  ACTIONS,
  isFinal,
  next,
  STATUSES,
  TransitionError,
  type OrderStatus,
} from '../../src/domain/order-status.js';

describe('конечный автомат заказа', () => {
  it.each([
    ['pending_payment', 'pay', 'paid'],
    ['pending_payment', 'cancel', 'cancelled'],
    ['pending_payment', 'expire', 'expired'],
    ['paid', 'refund', 'refunded'],
    ['expired', 'late_payment', 'refunded'],
  ] as const)('%s —%s→ %s', (from, action, to) => expect(next(from, action)).toBe(to));

  it('все остальные 20 пар «статус × действие» запрещены', () => {
    const allowed = new Set([
      'pending_payment:pay',
      'pending_payment:cancel',
      'pending_payment:expire',
      'paid:refund',
      'expired:late_payment',
    ]);
    let rejected = 0;
    for (const status of STATUSES) {
      for (const action of ACTIONS) {
        if (allowed.has(`${status}:${action}`)) continue;
        expect(() => next(status, action)).toThrow(TransitionError);
        rejected += 1;
      }
    }
    expect(rejected).toBe(STATUSES.length * ACTIONS.length - allowed.size);
  });

  it('у конечных статусов нет переходов', () => {
    expect(STATUSES.filter(isFinal)).toEqual(['cancelled', 'refunded']);
  });

  it('на любой случайной последовательности действий: деньги не списываются дважды и не возвращаются без оплаты', () => {
    // fast-check перебирает тысячи последовательностей и находит минимальный контрпример, если он есть
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ACTIONS), { maxLength: 30 }), (actions) => {
        let status: OrderStatus = 'pending_payment';
        let charged = 0;
        let refunded = 0;
        for (const action of actions) {
          try {
            const to = next(status, action);
            if (to === 'paid' || action === 'late_payment') charged += 1;
            if (to === 'refunded') refunded += 1;
            status = to;
          } catch (error) {
            expect(error).toBeInstanceOf(TransitionError);
          }
        }
        expect(charged).toBeLessThanOrEqual(1);
        expect(refunded).toBeLessThanOrEqual(charged);
        expect(STATUSES).toContain(status);
      }),
      { numRuns: 2000 },
    );
  });
});
