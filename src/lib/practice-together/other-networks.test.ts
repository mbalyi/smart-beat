import { otherNetworks, othersField } from "@/lib/practice-together/other-networks";

const MAIN = "ABCD-EFGH-JKMN-PQRS-TVWX";
const wifi = { name: "en0", kind: "wifi" as const, address: "192.168.1.5:5", code: MAIN };
const cable = {
  name: "en5",
  kind: "link-local" as const,
  address: "169.254.3.4:5",
  code: "1111-2222-3333-4444-5555",
};
const docker = {
  name: "docker0",
  kind: "other" as const,
  address: "172.17.0.1:5",
  code: "6666-7777-8888-9999-AAAA",
};

describe("otherNetworks", () => {
  it("lists the networks other than the main code's, in the host's order", () => {
    const info = { code: MAIN, link: "l", address: wifi.address, addresses: [wifi, cable, docker] };
    expect(otherNetworks(info)).toEqual([cable, docker]);
  });

  it("is empty for a host on one network, or a core that sends no list", () => {
    expect(otherNetworks({ code: MAIN, link: "l", address: "a", addresses: [wifi] })).toEqual([]);
    expect(otherNetworks({ code: MAIN, link: "l", address: "a" })).toEqual([]);
  });

  it("lists a code once", () => {
    const info = { code: MAIN, link: "l", address: "a", addresses: [wifi, cable, cable] };
    expect(otherNetworks(info)).toEqual([cable]);
  });
});

describe("othersField", () => {
  it("adds the other networks to the room code only when there are some", () => {
    expect(othersField({ code: MAIN, link: "l", address: "a", addresses: [wifi] })).toEqual({});
    expect(othersField({ code: MAIN, link: "l", address: "a", addresses: [wifi, cable] })).toEqual({
      others: [cable],
    });
  });
});
