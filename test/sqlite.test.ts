import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAuthClient } from "better-auth/client";
import { organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { spawn } from "bun";
import fs from "fs";
import path from "path";
import { auth, dataSource } from "./sqlite";

afterAll(async () => {
  await dataSource.destroy();
});

const typeormDir = path.join(__dirname, "typeorm");
if (fs.existsSync(typeormDir)) {
  fs.rmSync(typeormDir, { recursive: true });
}

beforeAll(async () => {
  await auth.api.signUpEmail({
    body: {
      email: "setup@test.com",
      password: "password123",
      name: "Setup User",
    },
  });
});

afterAll(async () => {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
});

const client = createAuthClient({
  baseURL: "http://localhost:3000",
  plugins: [organizationClient(), twoFactorClient()],
  fetchOptions: {
    customFetchImpl: async (url, init) => {
      return auth.handler(new Request(url, init));
    },
  },
});

async function signInAndGetHeaders(email: string, password: string): Promise<Headers> {
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const setCookies = res.headers.getSetCookie();
  const cookies = setCookies.map((c) => c.split(";")[0]).join("; ");
  return new Headers({ cookie: cookies });
}

describe("Sign Up", () => {
  test("should sign up a new user with email and password", async () => {
    const { data, error } = await client.signUp.email({
      email: "user1@test.com",
      password: "password123",
      name: "User One",
    });
    expect(error).toBeNull();
    expect(data?.user).toBeDefined();
    expect(data?.user?.email).toBe("user1@test.com");
    expect(data?.user?.name).toBe("User One");
  });

  test("should not allow duplicate email sign up", async () => {
    const { error } = await client.signUp.email({
      email: "user1@test.com",
      password: "password123",
      name: "User One Duplicate",
    });
    expect(error).not.toBeNull();
  });

  test("should reject weak password (too short)", async () => {
    const { error } = await client.signUp.email({
      email: "weakpass@test.com",
      password: "short",
      name: "Weak Pass",
    });
    expect(error).not.toBeNull();
  });
});

describe("Sign In", () => {
  test("should sign in with valid credentials", async () => {
    const { data, error } = await client.signIn.email({
      email: "user1@test.com",
      password: "password123",
    });
    expect(error).toBeNull();
    expect(data?.user).toBeDefined();
    expect(data?.user?.email).toBe("user1@test.com");
    expect(data?.token).toBeDefined();
  });

  test("should fail with wrong password", async () => {
    const { error } = await client.signIn.email({
      email: "user1@test.com",
      password: "wrongpassword",
    });
    expect(error).not.toBeNull();
  });

  test("should fail with non-existent email", async () => {
    const { error } = await client.signIn.email({
      email: "nonexistent@test.com",
      password: "password123",
    });
    expect(error).not.toBeNull();
  });
});

describe("Session", () => {
  test("should get session after sign in", async () => {
    const headers = await signInAndGetHeaders("user1@test.com", "password123");
    const session = await auth.api.getSession({ headers });
    expect(session).not.toBeNull();
    expect(session?.user?.email).toBe("user1@test.com");
  });

  test("should return null session with no cookies", async () => {
    const session = await auth.api.getSession({
      headers: new Headers(),
    });
    expect(session).toBeNull();
  });

  test("should list active sessions", async () => {
    const headers = await signInAndGetHeaders("user1@test.com", "password123");
    const sessions = await auth.api.listSessions({ headers });
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThan(0);
  });
});

describe("Update User", () => {
  test("should update user name", async () => {
    const headers = await signInAndGetHeaders("user1@test.com", "password123");
    const res = await auth.api.updateUser({
      headers,
      body: { name: "Updated Name" },
    });
    expect(res?.status).toBe(true);
    const session = await auth.api.getSession({ headers });
    expect(session?.user?.name).toBe("Updated Name");
  });

  test("should update user image", async () => {
    const headers = await signInAndGetHeaders("user1@test.com", "password123");
    await auth.api.updateUser({
      headers,
      body: { image: "https://example.com/avatar.png" },
    });
    const session = await auth.api.getSession({ headers });
    expect(session?.user?.image).toBe("https://example.com/avatar.png");
  });
});

describe("Change Password", () => {
  test("should change password successfully", async () => {
    await client.signUp.email({
      email: "changepw@test.com",
      password: "oldpassword123",
      name: "Change PW",
    });
    const headers = await signInAndGetHeaders("changepw@test.com", "oldpassword123");
    const res = await auth.api.changePassword({
      headers,
      body: {
        currentPassword: "oldpassword123",
        newPassword: "newpassword456",
      },
    });
    expect(res).toBeDefined();

    const { error } = await client.signIn.email({
      email: "changepw@test.com",
      password: "newpassword456",
    });
    expect(error).toBeNull();
  });

  test("should fail with wrong current password", async () => {
    const headers = await signInAndGetHeaders("changepw@test.com", "newpassword456");
    try {
      await auth.api.changePassword({
        headers,
        body: {
          currentPassword: "wrongcurrent",
          newPassword: "anothernew123",
        },
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeDefined();
    }
  });
});

describe("Sign Out", () => {
  test("should sign out and invalidate session", async () => {
    const headers = await signInAndGetHeaders("user1@test.com", "password123");
    const sessionBefore = await auth.api.getSession({ headers });
    expect(sessionBefore).not.toBeNull();

    await auth.api.signOut({ headers });

    const sessionAfter = await auth.api.getSession({ headers });
    expect(sessionAfter).toBeNull();
  });
});

describe("Multiple Users", () => {
  test("should handle multiple user sign ups and independent sessions", async () => {
    await client.signUp.email({
      email: "multi1@test.com",
      password: "password123",
      name: "Multi One",
    });
    await client.signUp.email({
      email: "multi2@test.com",
      password: "password123",
      name: "Multi Two",
    });

    const headers1 = await signInAndGetHeaders("multi1@test.com", "password123");
    const headers2 = await signInAndGetHeaders("multi2@test.com", "password123");

    const session1 = await auth.api.getSession({ headers: headers1 });
    const session2 = await auth.api.getSession({ headers: headers2 });

    expect(session1?.user?.email).toBe("multi1@test.com");
    expect(session2?.user?.email).toBe("multi2@test.com");
    expect(session1?.session?.id).not.toBe(session2?.session?.id);
  });
});

describe("Revoke Session", () => {
  test("should revoke a specific session", async () => {
    await client.signUp.email({
      email: "revoke@test.com",
      password: "password123",
      name: "Revoke User",
    });
    const headers = await signInAndGetHeaders("revoke@test.com", "password123");
    const sessions = await auth.api.listSessions({ headers });
    expect(sessions.length).toBeGreaterThan(0);

    await auth.api.revokeSession({
      headers,
      body: { token: sessions[0].token },
    });

    const sessionsAfter = await auth.api.listSessions({ headers });
    const revoked = sessionsAfter.find((s: { id: string }) => s.id === sessions[0].id);
    expect(revoked).toBeUndefined();
  });
});

describe("Organization Plugin", () => {
  test("should create an organization", async () => {
    await client.signUp.email({
      email: "orgowner@test.com",
      password: "password123",
      name: "Org Owner",
    });
    const headers = await signInAndGetHeaders("orgowner@test.com", "password123");
    const org = await auth.api.createOrganization({
      headers,
      body: {
        name: "Test Org",
        slug: "test-org",
      },
    });
    expect(org).toBeDefined();
    expect(org?.name).toBe("Test Org");
    expect(org?.slug).toBe("test-org");
  });

  test("should list organizations for a member", async () => {
    const headers = await signInAndGetHeaders("orgowner@test.com", "password123");
    const orgs = await auth.api.listOrganizations({ headers });
    expect(Array.isArray(orgs)).toBe(true);
    expect(orgs.length).toBeGreaterThan(0);
    expect(orgs.some((o: { slug: string }) => o.slug === "test-org")).toBe(true);
  });

  test("should get full organization details", async () => {
    const headers = await signInAndGetHeaders("orgowner@test.com", "password123");
    const org = await auth.api.getFullOrganization({
      headers,
      query: { organizationSlug: "test-org" },
    });
    expect(org).toBeDefined();
    expect(org?.members?.length).toBeGreaterThan(0);
  });

  test("should invite a member to organization", async () => {
    await client.signUp.email({
      email: "orgmember@test.com",
      password: "password123",
      name: "Org Member",
    });
    const headers = await signInAndGetHeaders("orgowner@test.com", "password123");
    const orgs = await auth.api.listOrganizations({ headers });
    const org = orgs.find((o: { slug: string }) => o.slug === "test-org");

    const invitation = await auth.api.createInvitation({
      headers,
      body: {
        email: "orgmember@test.com",
        role: "member",
        organizationId: org?.id,
      },
    });
    expect(invitation).toBeDefined();
  });

  test("should accept invitation and become member", async () => {
    const ownerHeaders = await signInAndGetHeaders("orgowner@test.com", "password123");
    const memberHeaders = await signInAndGetHeaders("orgmember@test.com", "password123");

    const orgs = await auth.api.listOrganizations({ headers: ownerHeaders });
    const org = orgs.find((o: { slug: string }) => o.slug === "test-org");
    expect(org).toBeDefined();

    const fullOrg = await auth.api.getFullOrganization({
      headers: ownerHeaders,
      query: { organizationSlug: "test-org" },
    });

    const invitation = fullOrg?.invitations?.find(
      (i: { email: string }) => i.email === "orgmember@test.com",
    );
    expect(invitation).toBeDefined();
    if (!invitation) {
      return;
    }

    await auth.api.acceptInvitation({
      headers: memberHeaders,
      body: { invitationId: invitation.id },
    });

    const memberOrgs = await auth.api.listOrganizations({
      headers: memberHeaders,
    });
    expect(memberOrgs.some((o: { slug: string }) => o.slug === "test-org")).toBe(true);
  });

  test("should update organization name", async () => {
    const headers = await signInAndGetHeaders("orgowner@test.com", "password123");
    const orgs = await auth.api.listOrganizations({ headers });
    const org = orgs.find((o: { slug: string }) => o.slug === "test-org");

    const updated = await auth.api.updateOrganization({
      headers,
      body: {
        data: { name: "Updated Org" },
        organizationId: org?.id,
      },
    });
    expect(updated?.name).toBe("Updated Org");
  });

  test("should reject an invitation", async () => {
    await client.signUp.email({
      email: "orgreject@test.com",
      password: "password123",
      name: "Reject User",
    });
    const ownerHeaders = await signInAndGetHeaders("orgowner@test.com", "password123");
    const orgs = await auth.api.listOrganizations({ headers: ownerHeaders });
    const org = orgs.find((o: { slug: string }) => o.slug === "test-org");

    await auth.api.createInvitation({
      headers: ownerHeaders,
      body: {
        email: "orgreject@test.com",
        role: "member",
        organizationId: org?.id,
      },
    });

    const rejectHeaders = await signInAndGetHeaders("orgreject@test.com", "password123");
    const fullOrg = await auth.api.getFullOrganization({
      headers: ownerHeaders,
      query: { organizationSlug: "test-org" },
    });
    const invitation = fullOrg?.invitations?.find(
      (i: { email: string; status: string }) =>
        i.email === "orgreject@test.com" && i.status === "pending",
    );
    expect(invitation).toBeDefined();
    if (!invitation) {
      return;
    }

    await auth.api.rejectInvitation({
      headers: rejectHeaders,
      body: { invitationId: invitation.id },
    });

    const updatedOrg = await auth.api.getFullOrganization({
      headers: ownerHeaders,
      query: { organizationSlug: "test-org" },
    });
    const rejected = updatedOrg?.invitations?.find((i: { id: string }) => i.id === invitation.id);
    expect(rejected?.status).toBe("rejected");
  });

  test("should cancel an invitation", async () => {
    await client.signUp.email({
      email: "orgcancel@test.com",
      password: "password123",
      name: "Cancel User",
    });
    const ownerHeaders = await signInAndGetHeaders("orgowner@test.com", "password123");
    const orgs = await auth.api.listOrganizations({ headers: ownerHeaders });
    const org = orgs.find((o: { slug: string }) => o.slug === "test-org");

    await auth.api.createInvitation({
      headers: ownerHeaders,
      body: {
        email: "orgcancel@test.com",
        role: "member",
        organizationId: org?.id,
      },
    });

    const fullOrg = await auth.api.getFullOrganization({
      headers: ownerHeaders,
      query: { organizationSlug: "test-org" },
    });
    const invitation = fullOrg?.invitations?.find(
      (i: { email: string; status: string }) =>
        i.email === "orgcancel@test.com" && i.status === "pending",
    );
    expect(invitation).toBeDefined();
    if (!invitation) {
      return;
    }

    await auth.api.cancelInvitation({
      headers: ownerHeaders,
      body: { invitationId: invitation.id },
    });

    const updatedOrg = await auth.api.getFullOrganization({
      headers: ownerHeaders,
      query: { organizationSlug: "test-org" },
    });
    const canceled = updatedOrg?.invitations?.find((i: { id: string }) => i.id === invitation.id);
    expect(canceled?.status).toBe("canceled");
  });

  test("should remove a member from organization", async () => {
    const ownerHeaders = await signInAndGetHeaders("orgowner@test.com", "password123");
    const orgs = await auth.api.listOrganizations({ headers: ownerHeaders });
    const org = orgs.find((o: { slug: string }) => o.slug === "test-org");

    await auth.api.removeMember({
      headers: ownerHeaders,
      body: {
        memberIdOrEmail: "orgmember@test.com",
        organizationId: org?.id,
      },
    });

    const fullOrg = await auth.api.getFullOrganization({
      headers: ownerHeaders,
      query: { organizationSlug: "test-org" },
    });
    const removed = fullOrg?.members?.find(
      (m: { user: { email: string } }) => m.user.email === "orgmember@test.com",
    );
    expect(removed).toBeUndefined();
  });

  test("should delete an organization", async () => {
    const headers = await signInAndGetHeaders("orgowner@test.com", "password123");
    const orgs = await auth.api.listOrganizations({ headers });
    const org = orgs.find((o: { slug: string }) => o.slug === "test-org");
    expect(org).toBeDefined();

    if (!org) {
      return;
    }

    await auth.api.deleteOrganization({
      headers,
      body: { organizationId: org.id },
    });

    const orgsAfter = await auth.api.listOrganizations({ headers });
    expect(orgsAfter.some((o: { slug: string }) => o.slug === "test-org")).toBe(false);
  });
});

describe("Two Factor Plugin", () => {
  test("should enable TOTP two factor", async () => {
    await client.signUp.email({
      email: "2fa@test.com",
      password: "password123",
      name: "2FA User",
    });
    const headers = await signInAndGetHeaders("2fa@test.com", "password123");
    const res = await auth.api.enableTwoFactor({
      headers,
      body: { password: "password123" },
    });
    expect(res).toBeDefined();
    expect(res?.totpURI).toBeDefined();
    expect(res?.backupCodes).toBeDefined();
  });
});

describe("Schema Generation (createSchema)", () => {
  test("should run generate cli without errors", async () => {
    const proc = spawn(["bunx", "auth", "generate", "--config", "sqlite.ts", "-y"], {
      cwd: __dirname,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    const entitiesDir = path.join(__dirname, "typeorm/entities");
    const migrationsDir = path.join(__dirname, "typeorm/migrations");

    expect(fs.existsSync(entitiesDir)).toBe(true);
    expect(fs.existsSync(migrationsDir)).toBe(true);

    const entities = fs.readdirSync(entitiesDir);
    expect(entities.length).toBeGreaterThan(0);

    const migrations = fs.readdirSync(migrationsDir);
    expect(migrations.length).toBeGreaterThan(0);
  });
});

describe("Delete User", () => {
  test("should delete a user account", async () => {
    await client.signUp.email({
      email: "delete@test.com",
      password: "password123",
      name: "Delete Me",
    });
    const headers = await signInAndGetHeaders("delete@test.com", "password123");

    await auth.api.deleteUser({
      headers,
      body: { password: "password123" },
    });

    const { error } = await client.signIn.email({
      email: "delete@test.com",
      password: "password123",
    });
    expect(error).not.toBeNull();
  });
});
