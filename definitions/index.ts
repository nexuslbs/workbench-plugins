// definitions/index.ts - the barrel of the service DEFINITIONS of this
// repository.
//
// Layout (docs/SERVICES.md): every capability of the service/transport stack is
// declared ONCE here, in the plugins repository, and is imported by the plugins
// that provide it and by the plugins that consume it. Nothing is imported from
// the workbench core, and no plugin of this repository imports `cordis`: the
// core is an EXTERNAL host for these plugins.
//
//   support.ts          shared infra: error taxonomy, service lookup / soft
//                       load-after wait, shell quoting, output caps, the
//                       manifest execution-policy gate
//   shell.ts            `shell@1`  - LOCAL execution (the only host transport)
//   ssh.ts              `ssh@1`    - execution on a remote machine
//   docker.ts           `docker@1` - execution inside a container (compose)
//   http.ts             `http@1`   - HTTP call, no shell
//   general-service.ts  `general-service@1` - ONE config-typed facade over the
//                       transports above (local | container | ssh |
//                       ssh+container | http)
//   himalaya.ts         `himalaya@1` - typed mail-CLI actions
//   email.ts            `email@1`    - the generic email capability (incl. send)
export * from './support.ts'
export * from './shell.ts'
export * from './ssh.ts'
export * from './docker.ts'
export * from './http.ts'
export * from './general-service.ts'
export * from './himalaya.ts'
export * from './email.ts'
