import {
  METADATA_PROVIDER_API_VERSION,
  type MetadataArtwork,
  type MetadataDetails,
  type MetadataMatchRequest,
  type MetadataMatchResult,
  type MetadataProvider,
  type MetadataProviderContext,
  type MetadataProviderReference,
  type MetadataSearchRequest,
  type MetadataSearchResult
} from './provider';

const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export class MetadataProviderRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataProviderRegistrationError';
  }
}

export class MetadataProviderNotFoundError extends Error {
  constructor(providerId: string) {
    super(`Metadata provider "${providerId}" is not registered`);
    this.name = 'MetadataProviderNotFoundError';
  }
}

/**
 * Owns provider discovery and request routing without exposing concrete
 * vendors to scanner, API, or persistence code.
 */
export class MetadataProviderRegistry {
  readonly #providers = new Map<string, MetadataProvider>();

  constructor(providers: readonly MetadataProvider[] = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: MetadataProvider): void {
    if (provider.apiVersion !== METADATA_PROVIDER_API_VERSION) {
      throw new MetadataProviderRegistrationError(
        `Metadata provider "${provider.id}" uses unsupported API version ${provider.apiVersion}; ` +
        `expected ${METADATA_PROVIDER_API_VERSION}`
      );
    }
    if (!PROVIDER_ID_PATTERN.test(provider.id)) {
      throw new MetadataProviderRegistrationError(
        `Metadata provider ID "${provider.id}" must use lowercase letters, numbers, dots, underscores, or hyphens`
      );
    }
    if (!provider.displayName.trim()) {
      throw new MetadataProviderRegistrationError(
        `Metadata provider "${provider.id}" must have a display name`
      );
    }
    if (this.#providers.has(provider.id)) {
      throw new MetadataProviderRegistrationError(
        `Metadata provider "${provider.id}" is already registered`
      );
    }

    this.#providers.set(provider.id, provider);
  }

  unregister(providerId: string): boolean {
    return this.#providers.delete(providerId);
  }

  get(providerId: string): MetadataProvider | undefined {
    return this.#providers.get(providerId);
  }

  list(): readonly MetadataProvider[] {
    return [...this.#providers.values()];
  }

  search(
    providerId: string,
    request: MetadataSearchRequest,
    context?: MetadataProviderContext
  ): Promise<readonly MetadataSearchResult[]> {
    return this.#require(providerId).search(request, context);
  }

  match(
    providerId: string,
    request: MetadataMatchRequest,
    context?: MetadataProviderContext
  ): Promise<MetadataMatchResult> {
    return this.#require(providerId).match(request, context);
  }

  getDetails(
    reference: MetadataProviderReference,
    context?: MetadataProviderContext
  ): Promise<MetadataDetails | null> {
    return this.#require(reference.providerId).getDetails(reference, context);
  }

  getArtwork(
    reference: MetadataProviderReference,
    context?: MetadataProviderContext
  ): Promise<readonly MetadataArtwork[]> {
    return this.#require(reference.providerId).getArtwork(reference, context);
  }

  #require(providerId: string): MetadataProvider {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new MetadataProviderNotFoundError(providerId);
    }
    return provider;
  }
}
