import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Pasta com os scripts auxiliares (funciona tanto em src/ via ts-node quanto em dist/). */
export const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

/** Resolução da tela no Linux: SCREEN_WIDTH/SCREEN_HEIGHT no .env, senão xrandr, senão DRM/KMS (Wayland), senão 1920x1080. */
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

  // Fallback nativo para sessões Wayland puras via /sys/class/drm
  try {
    const drmDir = '/sys/class/drm';
    if (fs.existsSync(drmDir)) {
      for (const entry of fs.readdirSync(drmDir)) {
        const statusFile = path.join(drmDir, entry, 'status');
        const modesFile = path.join(drmDir, entry, 'modes');
        if (fs.existsSync(statusFile) && fs.existsSync(modesFile)) {
          const status = fs.readFileSync(statusFile, 'utf8').trim();
          if (status === 'connected') {
            const firstMode = fs.readFileSync(modesFile, 'utf8').split(/\r?\n/)[0]?.trim();
            const m = firstMode?.match(/^(\d+)x(\d+)/);
            if (m) return { width: Number(m[1]), height: Number(m[2]) };
          }
        }
      }
    }
  } catch {
    // Fallback padrão
  }

  return { width: 1920, height: 1080 };
}

/**
 * Garante acesso do usuário atual aos dispositivos informados (ACL via setfacl).
 * Verifica apenas permissão de leitura para mouses e teclados, e leitura/escrita para /dev/uinput.
 */
export function ensureLinuxDeviceAccess(devices: string[]): boolean {
  if (!fs.existsSync('/dev/uinput')) {
    console.log('[Linux] Módulo /dev/uinput não encontrado. Tentando carregar...');
    try {
      const modRes = spawnSync('sudo', ['-n', 'modprobe', 'uinput'], { stdio: 'ignore' });
      if (modRes.status !== 0 && process.stdin.isTTY) {
        spawnSync('sudo', ['modprobe', 'uinput'], { stdio: 'inherit' });
      }
    } catch {}
  }

  const denied = devices.filter((dev) => {
    try {
      const mode = dev === '/dev/uinput' ? (fs.constants.R_OK | fs.constants.W_OK) : fs.constants.R_OK;
      fs.accessSync(dev, mode);
      return false;
    } catch {
      return fs.existsSync(dev);
    }
  });

  if (denied.length === 0) return true;

  const user = os.userInfo().username;

  // 1. Tenta sudo sem senha (sudo -n) primeiro para não travar interfaces não-interativas
  const nonInteractive = spawnSync('sudo', ['-n', 'setfacl', '-m', `u:${user}:rw`, ...denied], {
    stdio: 'ignore',
  });
  if (nonInteractive.status === 0) {
    console.log(`[Linux] Permissões liberadas via sudo para o usuário "${user}".`);
    return true;
  }

  // 2. Se houver TTY interativo, tenta solicitar senha ao usuário
  if (process.stdin.isTTY) {
    console.log(`[Linux] Liberando acesso a ${denied.join(', ')} para o usuário "${user}" (sudo)...`);
    const result = spawnSync('sudo', ['setfacl', '-m', `u:${user}:rw`, ...denied], { stdio: 'inherit' });
    if (result.status === 0) {
      return true;
    }
  }

  // 3. Se não foi possível liberar automaticamente, avisa com instruções claras
  console.warn(
    `\n[Linux] ⚠️ PERMISSÃO NECESSÁRIA:\n` +
      `        O usuário "${user}" não tem permissão nos dispositivos:\n` +
      `        ${denied.join(', ')}\n\n` +
      `        Para liberar imediatamente, execute no terminal:\n` +
      `        sudo setfacl -m u:${user}:rw ${denied.join(' ')}\n\n` +
      `        Ou execute o script de instalação permanente:\n` +
      `        sudo bash scripts/setup-deps.sh\n`
  );

  return false;
}
