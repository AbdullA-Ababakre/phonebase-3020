export type RentalLease = {
  id: string;
  customer: string;
  deviceId: string;
  deviceIds: string[];
  startsAt: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  scopes: ["device:read", "device:control"];
};

export type RentalLeaseRegistry = {
  version: 1 | 2;
  leases: RentalLease[];
};

export function normalizeRentalLeaseRegistry(value: unknown): RentalLeaseRegistry;
export function readRentalLeaseRegistry(path: string): Promise<RentalLeaseRegistry>;
export function writeRentalLeaseRegistry(
  path: string,
  registry: RentalLeaseRegistry,
): Promise<RentalLeaseRegistry>;
export function monthlyLeaseEnd(start: Date, months?: number): Date;
export function rentalLeaseActive(lease: RentalLease, now?: Date): boolean;
export function createRentalLease(
  registry: RentalLeaseRegistry,
  input: { deviceId?: string; deviceIds?: string[]; customer: string; months?: number },
  now?: Date,
): { lease: RentalLease; registry: RentalLeaseRegistry };
export function renewRentalLease(
  registry: RentalLeaseRegistry,
  leaseId: string,
  months?: number,
  now?: Date,
): { lease: RentalLease; registry: RentalLeaseRegistry };
export function revokeRentalLease(
  registry: RentalLeaseRegistry,
  leaseId: string,
  now?: Date,
): { lease: RentalLease; registry: RentalLeaseRegistry };
export function createRentalShortCode(lease: RentalLease, secret: string): string;
export function createRentalLeaseToken(lease: RentalLease, secret: string): string;
export function verifyRentalLeaseToken(
  token: string,
  secret: string,
  registry: RentalLeaseRegistry,
  now?: Date,
): RentalLease;


export function rentalLeaseAllowsDevice(lease: RentalLease, deviceId: string | null): boolean;
