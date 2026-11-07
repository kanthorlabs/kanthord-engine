import type { EventDecoder } from "../../mission/contract.ts";
import { RepositoryPlatform } from "../../project/contract.ts";
import {
  decodeGitHubEvent,
  decodeGitHubLinkUpdate,
} from "../../repository/index.ts";

export const missionEventDecoder: EventDecoder = {
  decode: ({ platform, resource, event, metadata }) =>
    platform === RepositoryPlatform.GitHub
      ? decodeGitHubEvent({ resource, event, metadata })
      : null,
  decodeLinkUpdate: ({ platform, resource, event, metadata }) =>
    platform === RepositoryPlatform.GitHub
      ? decodeGitHubLinkUpdate({ resource_identity: resource, event, metadata })
      : null,
};
