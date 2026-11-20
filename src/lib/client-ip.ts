import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

/**
 * Адрес клиента для лимитов.
 *
 * 1. CLIENT_IP_HEADER (на Render — cf-connecting-ip): его ставит Cloudflare и перезаписывает присланный клиентом.
 * 2. request.ip: Fastify с trustProxy = PROXY_HOPS берёт адрес на этой позиции справа в X-Forwarded-For —
 *    только эти записи дописали наши прокси. Без доверия к прокси это адрес соединения.
 */
export function clientIp(request: FastifyRequest, config: Pick<Config, 'CLIENT_IP_HEADER'>): string {
  if (config.CLIENT_IP_HEADER) {
    const value = request.headers[config.CLIENT_IP_HEADER];
    const ip = (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
    if (isIP(ip)) return ip;
  }
  return request.ip;
}
