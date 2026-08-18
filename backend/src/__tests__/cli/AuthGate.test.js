const { Keypair } = require("@stellar/stellar-sdk");
const { authenticate, roleSatisfies, AuthError } = require("../../cli/AuthGate");

const readonlyKp = Keypair.random();
const moderatorKp = Keypair.random();
const superadminKp = Keypair.random();
const strangerKp = Keypair.random();

const ALLOWLIST = [
  { publicKey: readonlyKp.publicKey(), role: "readonly" },
  { publicKey: moderatorKp.publicKey(), role: "moderator" },
  { publicKey: superadminKp.publicKey(), role: "superadmin" },
];

describe("AuthGate.authenticate", () => {
  it("rejects a command signed by a key not on the operator allowlist", () => {
    expect(() =>
      authenticate({ secretKey: strangerKp.secret(), minRole: "readonly", allowlist: ALLOWLIST })
    ).toThrow(AuthError);
    expect(() =>
      authenticate({ secretKey: strangerKp.secret(), minRole: "readonly", allowlist: ALLOWLIST })
    ).toThrow(/not on the operator allowlist/);
  });

  it("accepts an allowlisted key that meets the required role", () => {
    const { publicKey, role } = authenticate({
      secretKey: superadminKp.secret(),
      minRole: "superadmin",
      allowlist: ALLOWLIST,
    });
    expect(publicKey).toBe(superadminKp.publicKey());
    expect(role).toBe("superadmin");
  });

  it.each(["moderator", "superadmin"])(
    "rejects a readonly-role operator key on a command requiring '%s'",
    (minRole) => {
      expect(() =>
        authenticate({ secretKey: readonlyKp.secret(), minRole, allowlist: ALLOWLIST })
      ).toThrow(/has role 'readonly'/);
    }
  );

  it("rejects a moderator-role operator key on a superadmin-only command", () => {
    expect(() =>
      authenticate({ secretKey: moderatorKp.secret(), minRole: "superadmin", allowlist: ALLOWLIST })
    ).toThrow(AuthError);
  });

  it("allows a higher role than required (superadmin can run a readonly command)", () => {
    expect(() =>
      authenticate({ secretKey: superadminKp.secret(), minRole: "readonly", allowlist: ALLOWLIST })
    ).not.toThrow();
  });

  it("requires a secret key to be configured", () => {
    expect(() => authenticate({ secretKey: undefined, allowlist: ALLOWLIST })).toThrow(
      /OPERATOR_SECRET_KEY is not set/
    );
  });

  it("rejects a malformed secret key", () => {
    expect(() => authenticate({ secretKey: "not-a-real-key", allowlist: ALLOWLIST })).toThrow(
      /invalid operator secret key/
    );
  });
});

describe("roleSatisfies", () => {
  it.each([
    ["superadmin", "readonly", true],
    ["superadmin", "moderator", true],
    ["superadmin", "superadmin", true],
    ["moderator", "superadmin", false],
    ["readonly", "moderator", false],
    ["bogus", "readonly", false],
  ])("roleSatisfies(%s, %s) === %s", (role, minRole, expected) => {
    expect(roleSatisfies(role, minRole)).toBe(expected);
  });
});
