#!/usr/bin/env bash
set -e

# ==============================================================================
# Script de Instalação Automática de Dependências do Mult-System KVM
# Suporta: Debian/Ubuntu, Fedora, Arch Linux, openSUSE
# ==============================================================================

echo "========================================================"
echo "  Mult-System KVM — Instalador de Dependências do Sistema"
echo "========================================================"

if [ "$EUID" -ne 0 ]; then
  echo "[-] Este script requer privilégios de superusuário (sudo)."
  echo "    Executando com sudo..."
  exec sudo bash "$0" "$@"
fi

CURRENT_USER="${SUDO_USER:-$USER}"

echo "[+] Usuário detectado: $CURRENT_USER"
echo "[+] Detectando gerenciador de pacotes..."

if command -v apt-get >/dev/null 2>&1; then
  echo "[+] Sistema baseado em Debian/Ubuntu detectado."
  apt-get update -y
  apt-get install -y \
    acl \
    python3 \
    python3-pip \
    python3-evdev \
    python3-gi \
    gir1.2-gtk-3.0 \
    wl-clipboard \
    xclip \
    openssl \
    x11-xserver-utils
elif command -v dnf >/dev/null 2>&1; then
  echo "[+] Sistema baseado em Fedora/RHEL detectado."
  dnf install -y \
    acl \
    python3 \
    python3-pip \
    python3-evdev \
    python3-gobject \
    gtk3 \
    wl-clipboard \
    xclip \
    openssl \
    xrandr
elif command -v pacman >/dev/null 2>&1; then
  echo "[+] Sistema baseado em Arch Linux detectado."
  pacman -Sy --noconfirm \
    acl \
    python \
    python-pip \
    python-evdev \
    python-gobject \
    gtk3 \
    wl-clipboard \
    xclip \
    openssl \
    xorg-xrandr
elif command -v zypper >/dev/null 2>&1; then
  echo "[+] Sistema baseado em openSUSE detectado."
  zypper install -y \
    acl \
    python3 \
    python3-pip \
    python3-evdev \
    python3-gobject \
    gtk3 \
    wl-clipboard \
    xclip \
    openssl
else
  echo "[!] Gerenciador de pacotes não reconhecido automaticamente."
  echo "    Por favor, instale manualmente: acl (setfacl), python3, python3-evdev, python3-gi, wl-clipboard, xclip, openssl."
fi

# Configuração do módulo uinput
echo "[+] Carregando módulo de kernel uinput..."
modprobe uinput || true

# Configura uinput para carregar automaticamente no boot
if [ ! -f /etc/modules-load.d/uinput.conf ]; then
  echo "uinput" > /etc/modules-load.d/uinput.conf
  echo "[+] Configurado carregamento automático do uinput em /etc/modules-load.d/uinput.conf."
fi

# Configura regra udev para uinput
cat << 'EOF' > /etc/udev/rules.d/99-mult-system-kvm.rules
KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"
EOF
udevadm control --reload-rules || true
udevadm trigger || true

# Adiciona o usuário ao grupo input
if getent group input >/dev/null; then
  usermod -aG input "$CURRENT_USER"
  echo "[+] Usuário '$CURRENT_USER' adicionado ao grupo 'input'."
fi

# Permissão Imediata via ACL no /dev/uinput
if [ -e /dev/uinput ]; then
  setfacl -m "u:$CURRENT_USER:rw" /dev/uinput || true
  echo "[+] Permissão ACL de leitura/escrita concedida em /dev/uinput para $CURRENT_USER."
fi

echo ""
echo "========================================================"
echo "  Dependências instaladas com sucesso!"
echo "  Dica: Se foi adicionado ao grupo 'input', pode ser"
echo "  necessário fazer logout e login novamente para surtir efeito."
echo "========================================================"
