import { useCallback, useSyncExternalStore } from "react";
import type { ConnectionState, InspectorClient } from "./client.ts";

/** A state topic's value, or a stream topic's items. */
export function useTopic<T>(client: InspectorClient, topic: string): T | undefined {
  return useSyncExternalStore(
    useCallback((fn) => client.subscribe(topic, fn), [client, topic]),
    () => client.get<T>(topic),
  );
}

const EMPTY: readonly never[] = [];

export function useStream<T>(client: InspectorClient, topic: string): readonly T[] {
  return useTopic<T[]>(client, topic) ?? EMPTY;
}

export function useConnection(client: InspectorClient): ConnectionState {
  return useSyncExternalStore(
    useCallback((fn) => client.subscribe("$connection", fn), [client]),
    () => client.connection,
  );
}

export function useCommand(client: InspectorClient) {
  return useCallback(<T = unknown>(name: string, args?: unknown) => client.command<T>(name, args), [client]);
}
