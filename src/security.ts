import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { computeHmac, generateAuthNonce, saveEnv, verifyHmac } from './protocol';

const CERTS_DIR = path.resolve(process.cwd(), 'certs');
const CERT_FILE = path.join(CERTS_DIR, 'cert.pem');
const KEY_FILE = path.join(CERTS_DIR, 'key.pem');

/**
 * Obtém ou inicializa a chave secreta compartilhada (PSK) no .env
 */
export function getOrCreateSecretKey(): string {
  let key = process.env.KVM_SECRET_KEY;
  if (!key || key.trim() === '') {
    key = crypto.randomBytes(16).toString('hex');
    process.env.KVM_SECRET_KEY = key;
    try {
      saveEnv({ KVM_SECRET_KEY: key });
      console.log(`[Segurança] Nova chave KVM_SECRET_KEY gerada e salva no .env: ${key.slice(0, 4)}...****`);
    } catch {
      // Ignora erro se filesystem for somente-leitura
    }
  }
  return key;
}

/**
 * Verifica se TLS está ativado na configuração
 */
export function isTLSEnabled(): boolean {
  return process.env.KVM_USE_TLS === 'true' || process.env.KVM_USE_TLS === '1';
}

export interface TLSCredentials {
  cert: string;
  key: string;
}

/**
 * Gera ou carrega certificado TLS autoassinado para sockets seguros
 */
export function getOrCreateTLSCredentials(): TLSCredentials | null {
  if (!isTLSEnabled()) return null;

  try {
    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
      return {
        cert: fs.readFileSync(CERT_FILE, 'utf8'),
        key: fs.readFileSync(KEY_FILE, 'utf8'),
      };
    }

    if (!fs.existsSync(CERTS_DIR)) {
      fs.mkdirSync(CERTS_DIR, { recursive: true });
    }

    // Gera certificado autoassinado via OpenSSL se disponível
    console.log('[Segurança] Gerando certificado TLS autoassinado em certs/...');
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      KEY_FILE,
      '-out',
      CERT_FILE,
      '-days',
      '3650',
      '-nodes',
      '-subj',
      '/CN=MultSystemKVM/O=MultSystem',
    ]);

    return {
      cert: fs.readFileSync(CERT_FILE, 'utf8'),
      key: fs.readFileSync(KEY_FILE, 'utf8'),
    };
  } catch (err) {
    console.warn('[Segurança] Não foi possível gerar certificado TLS via openssl. Usando modo TCP com HMAC PSK.');
    return null;
  }
}

export { computeHmac, generateAuthNonce, verifyHmac };
