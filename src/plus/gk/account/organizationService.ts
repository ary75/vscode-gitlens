import { Disposable, window } from 'vscode';
import type { Container } from '../../../container';
import { setContext } from '../../../system/context';
import { gate } from '../../../system/decorators/gate';
import { Logger } from '../../../system/logger';
import { getLogScope } from '../../../system/logger.scope';
import type { ServerConnection } from '../serverConnection';
import type { Organization } from './organization';
import type { SubscriptionChangeEvent } from './subscriptionService';

const organizationsCacheExpiration = 24 * 60 * 60 * 1000; // 1 day

export class OrganizationService implements Disposable {
	private _disposable: Disposable;
	private _organizations: Organization[] | null | undefined;

	constructor(
		private readonly container: Container,
		private readonly connection: ServerConnection,
	) {
		this._disposable = Disposable.from(container.subscription.onDidChange(this.onSubscriptionChanged, this));
		const userId = container.subscription.subscriptionAccountId;
		if (userId != null) {
			this.loadStoredOrganizations(userId);
		}
	}

	dispose(): void {
		this._disposable.dispose();
	}

	get organizationCount(): number {
		return this._organizations?.length ?? 0;
	}

	@gate()
	async getOrganizations(options?: {
		force?: boolean;
		accessToken?: string;
		userId?: string;
	}): Promise<Organization[] | null | undefined> {
		const scope = getLogScope();
		const userId = options?.userId ?? this.container.subscription.subscriptionAccountId;
		if (userId == null) {
			this.updateOrganizations(undefined);
			return this._organizations;
		}

		if (this._organizations === undefined || options?.force) {
			if (!options?.force) {
				this.loadStoredOrganizations(userId);
				if (this._organizations != null) return this._organizations;
			}

			let rsp;
			try {
				rsp = await this.connection.fetchApi(
					'user/organizations-light',
					{
						method: 'GET',
					},
					{ token: options?.accessToken },
				);
			} catch (ex) {
				this.updateOrganizations(undefined);
				return this._organizations;
			}

			if (!rsp.ok) {
				debugger;
				Logger.error('', scope, `Unable to get organizations; status=(${rsp.status}): ${rsp.statusText}`);

				void window.showErrorMessage(`Unable to get organizations; Status: ${rsp.statusText}`, 'OK');

				// Setting to null prevents hitting the API again until you reload
				this.updateOrganizations(null);
			}

			const organizationsResponse = await rsp.json();
			const organizations = organizationsResponse.map((o: any) => ({
				id: o.id,
				name: o.name,
				role: o.role,
			}));

			await this.storeOrganizations(organizations, userId);
			this.updateOrganizations(organizations);
		}

		return this._organizations;
	}

	@gate()
	private loadStoredOrganizations(userId: string): void {
		const storedOrganizations = this.container.storage.get('gk:organizations');
		if (storedOrganizations == null) return;
		const { timestamp, organizations, userId: storedUserId } = storedOrganizations;
		if (storedUserId !== userId || timestamp + organizationsCacheExpiration < Date.now()) {
			return;
		}

		this.updateOrganizations(organizations);
	}

	private async storeOrganizations(organizations: Organization[], userId: string): Promise<void> {
		return this.container.storage.store('gk:organizations', {
			timestamp: Date.now(),
			organizations: organizations,
			userId: userId,
		});
	}

	private onSubscriptionChanged(e: SubscriptionChangeEvent): void {
		if (e.current?.account?.id == null) {
			this.updateOrganizations(undefined);
		}
	}

	private updateOrganizations(organizations: Organization[] | null | undefined): void {
		this._organizations = organizations;
		void setContext('gitlens:gk:hasMultipleOrganizationOptions', this.organizationCount > 1);
	}
}