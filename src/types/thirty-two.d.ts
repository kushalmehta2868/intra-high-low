declare module 'thirty-two' {
  export function encode(plain: string | Buffer): Buffer;
  export function decode(encoded: string | Buffer): Buffer;
}
