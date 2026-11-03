import { Key } from '@nut-tree-fork/nut-js';
import { UiohookKey } from 'uiohook-napi';

export type ScreenEdge = 'left' | 'right';

export type KVMPacket =
  | { type: 'enter_client'; yRatio: number }
  | { type: 'return_server'; yRatio: number }
  | { type: 'mousemove'; dx: number; dy: number }
  | { type: 'mousedown'; button: number }
  | { type: 'mouseup'; button: number }
  | { type: 'wheel'; amount: number; direction: number }
  | { type: 'keydown'; keycode: number }
  | { type: 'keyup'; keycode: number };

/**
 * Serializa um pacote adicionando delimitador de quebra de linha (NDJSON)
 * para evitar problemas de fragmentação/concatenação no stream TCP.
 */
export function serializePacket(packet: KVMPacket): string {
  return JSON.stringify(packet) + '\n';
}

/**
 * Mapeamento básico de keycodes do uiohook-napi para a enum Key do nut-js.
 * Pode ser expandido conforme necessidade.
 */
export const UIOHOOK_TO_NUT_KEY: Record<number, Key> = {
  [UiohookKey.A]: Key.A,
  [UiohookKey.B]: Key.B,
  [UiohookKey.C]: Key.C,
  [UiohookKey.D]: Key.D,
  [UiohookKey.E]: Key.E,
  [UiohookKey.F]: Key.F,
  [UiohookKey.G]: Key.G,
  [UiohookKey.H]: Key.H,
  [UiohookKey.I]: Key.I,
  [UiohookKey.J]: Key.J,
  [UiohookKey.K]: Key.K,
  [UiohookKey.L]: Key.L,
  [UiohookKey.M]: Key.M,
  [UiohookKey.N]: Key.N,
  [UiohookKey.O]: Key.O,
  [UiohookKey.P]: Key.P,
  [UiohookKey.Q]: Key.Q,
  [UiohookKey.R]: Key.R,
  [UiohookKey.S]: Key.S,
  [UiohookKey.T]: Key.T,
  [UiohookKey.U]: Key.U,
  [UiohookKey.V]: Key.V,
  [UiohookKey.W]: Key.W,
  [UiohookKey.X]: Key.X,
  [UiohookKey.Y]: Key.Y,
  [UiohookKey.Z]: Key.Z,
  [UiohookKey['1']]: Key.Num1,
  [UiohookKey['2']]: Key.Num2,
  [UiohookKey['3']]: Key.Num3,
  [UiohookKey['4']]: Key.Num4,
  [UiohookKey['5']]: Key.Num5,
  [UiohookKey['6']]: Key.Num6,
  [UiohookKey['7']]: Key.Num7,
  [UiohookKey['8']]: Key.Num8,
  [UiohookKey['9']]: Key.Num9,
  [UiohookKey['0']]: Key.Num0,
  [UiohookKey.Space]: Key.Space,
  [UiohookKey.Enter]: Key.Return,
  [UiohookKey.Backspace]: Key.Backspace,
  [UiohookKey.Tab]: Key.Tab,
  [UiohookKey.Escape]: Key.Escape,
  [UiohookKey.Shift]: Key.LeftShift,
  [UiohookKey.ShiftRight]: Key.RightShift,
  [UiohookKey.Ctrl]: Key.LeftControl,
  [UiohookKey.CtrlRight]: Key.RightControl,
  [UiohookKey.Alt]: Key.LeftAlt,
  [UiohookKey.AltRight]: Key.RightAlt,
  [UiohookKey.Meta]: Key.LeftSuper,
  [UiohookKey.ArrowUp]: Key.Up,
  [UiohookKey.ArrowDown]: Key.Down,
  [UiohookKey.ArrowLeft]: Key.Left,
  [UiohookKey.ArrowRight]: Key.Right,
};
