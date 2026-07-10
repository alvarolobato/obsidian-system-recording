/**
 * Type definitions for fvad-wasm libraries
 */

declare module '@echogarden/fvad-wasm' {
  export enum VADEvent {
    ERROR = -1,
    SILENCE = 0,
    VOICE = 1
  }

  export class VAD {
  	constructor(mode: number, rate: number);
  	processFrame(frame: Int16Array): VADEvent;
  	processBuffer(buffer: Int16Array): VADEvent;
  	destroy(): void;
  	static floatTo16BitPCM(buffer: Float32Array): Int16Array;
  }

  export const VAD_FRAME: number;
}

declare module 'libfvad-wasm' {
  export enum VADEvent {
    ERROR = -1,
    SILENCE = 0,
    VOICE = 1
  }

  export class VAD {
  	constructor(mode: number, rate: number);
  	processFrame(frame: Int16Array): VADEvent;
  	processBuffer(buffer: Int16Array): VADEvent;
  	destroy(): void;
  	static floatTo16BitPCM(buffer: Float32Array): Int16Array;
  }

  export const VAD_FRAME: number;
}