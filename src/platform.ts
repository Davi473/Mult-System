import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Pasta com os scripts auxiliares (funciona tanto em src/ via ts-node quanto em dist/). */
export const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

/** Resolução da tela no Linux: SCREEN_WIDTH/SCREEN_HEIGHT no .env, senão xrandr, senão 1920x1080. */
export function detectLinuxScreen(): { width: number; height: number } {
  const envW = Number(process.env.SCREEN_WIDTH);
  const envH = Number(process.env.SCREEN_HEIGHT);
  if (envW > 0 && envH > 0) return { width: envW, height: envH };

  try {
    const out = execFileSync('xrandr', ['--current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = out.match(/current (\d+) x (\d+)/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    // xrandr indisponível
  }
  return { width: 1920, height: 1080 };
}

/**
 * Garante leitura/escrita do usuário atual nos dispositivos informados (ACL via setfacl).
 * Pede a senha do sudo apenas se necessário.
 */
export function ensureLinuxDeviceAccess(devices: string[]): void {
  if (!fs.existsSync('/dev/uinput')) {
    console.log('[Linux] Carregando módulo uinput (sudo modprobe uinput)...');
    spawnSync('sudo', ['modprobe', 'uinput'], { stdio: 'inherit' });
  }

  const denied = devices.filter((dev) => {
    try {
      fs.accessSync(dev, fs.constants.R_OK | fs.constants.W_OK);
      return false;
    } catch {
      return fs.existsSync(dev);
    }
  });
  if (denied.length === 0) return;

  const user = os.userInfo().username;
  console.log(`[Linux] Liberando acesso a ${denied.join(', ')} para o usuário "${user}" (sudo)...`);
  const result = spawnSync('sudo', ['setfacl', '-m', `u:${user}:rw`, ...denied], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.warn(
      `[Linux] Não foi possível liberar as permissões. Alternativa permanente:\n` +
        `        sudo usermod -aG input ${user}   (depois faça logout/login)`
    );
  }
}
