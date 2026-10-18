/**
 * @roombook/shared — the contract between the server and the client.
 *
 * Imported by both sides so that schemas, response types and the permission
 * matrix have exactly one definition and cannot drift apart.
 *
 * This package must stay free of any dependency on Express, Prisma, React or
 * Node built-ins, so that it runs unchanged in the browser. The lint boundary
 * rules enforce that (docs/02-architecture.md section 5).
 */

export * from './enums.js'
export * from './errors.js'
export * from './time.js'
export * from './permissions.js'
export * from './schemas/auth.js'
export * from './schemas/booking.js'
export * from './schemas/room.js'
export * from './schemas/user.js'
