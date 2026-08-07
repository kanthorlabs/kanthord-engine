import net from "node:net";

export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}
