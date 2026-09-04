export type ChannelKey = "woolworths-ordering" | "order-import";

export interface RemoteMcpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  channelKey: ChannelKey;
  mcpServers: Record<string, RemoteMcpServerConfig>;
}

export interface ContainerOutput {
  status: "success" | "error";
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface ProposeAction {
  summary: string;
  items: PendingActionItem[];
}

export interface PendingActionItem {
  name?: string;
  sku: string | number;
  quantity: number;
  pricingUnit?: "EACH" | "KG";
}
