import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { McpSettings } from "./McpSettings.js";

describe("McpSettings", () => {
  it("adds and saves a Streamable HTTP server with request headers", async () => {
    const mock = createMockHertaBridge();
    const { getByRole, getByLabelText, queryByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <McpSettings />
      </HertaBridgeProvider>,
    );

    await waitFor(() => expect(mock.calls.getMcpConfig).toBe(1));
    fireEvent.click(getByRole("button", { name: "Add service" }));
    fireEvent.change(getByLabelText("Service name"), {
      target: { value: "remote-tools" },
    });
    fireEvent.change(getByLabelText("Transport"), {
      target: { value: "streamable-http" },
    });
    fireEvent.change(getByLabelText("Server URL"), {
      target: { value: "https://mcp.example.test/mcp" },
    });
    fireEvent.change(getByLabelText("Request headers"), {
      target: { value: "Authorization=Bearer token\nX-Client=Herta" },
    });
    fireEvent.click(getByRole("button", { name: "Save configuration" }));

    await waitFor(() =>
      expect(mock.calls.setMcpConfig).toEqual([
        {
          mcpServers: {
            "remote-tools": {
              transport: "streamable-http",
              url: "https://mcp.example.test/mcp",
              headers: {
                Authorization: "Bearer token",
                "X-Client": "Herta",
              },
            },
          },
        },
      ]),
    );
    expect(
      queryByText(
        "MCP configuration saved. Create a new session to use the updated services.",
      ),
    ).toBeTruthy();
  });

  it("does not save incomplete services and surfaces a local validation error", async () => {
    const mock = createMockHertaBridge();
    const { getByRole, queryByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <McpSettings />
      </HertaBridgeProvider>,
    );

    await waitFor(() => expect(mock.calls.getMcpConfig).toBe(1));
    fireEvent.click(getByRole("button", { name: "Add service" }));
    fireEvent.click(getByRole("button", { name: "Save configuration" }));

    expect(mock.calls.setMcpConfig).toEqual([]);
    expect(
      queryByText(
        "Give every service a unique name and check its command, URL, and KEY=VALUE entries.",
      ),
    ).toBeTruthy();
  });
});
