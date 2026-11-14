declare global {
  interface Window { gubbo: { invoke(channel: string, payload?: unknown): Promise<any>; on(channel: string, cb: (payload: any) => void): () => void } }
}
export const call = <T = any>(channel: string, payload?: unknown): Promise<T> => window.gubbo.invoke(channel, payload) as Promise<T>;
export const on = (channel: string, cb: (payload: any) => void) => window.gubbo.on(channel, cb);
