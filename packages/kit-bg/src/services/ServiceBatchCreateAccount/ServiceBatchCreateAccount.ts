import { HardwareErrorCode } from '@onekeyfe/hd-shared';
import { chunk, isNil, range } from 'lodash';

import {
  backgroundClass,
  backgroundMethod,
  toastIfError,
} from '@onekeyhq/shared/src/background/backgroundDecorators';
import { getNetworkIdsMap } from '@onekeyhq/shared/src/config/networkIds';
import { IMPL_EVM } from '@onekeyhq/shared/src/engine/engineConsts';
import {
  isHardwareErrorByCode,
  isHardwareInterruptErrorByCode,
} from '@onekeyhq/shared/src/errors/utils/deviceErrorUtils';
import {
  EAppEventBusNames,
  appEventBus,
} from '@onekeyhq/shared/src/eventBus/appEventBus';
import accountUtils from '@onekeyhq/shared/src/utils/accountUtils';
import { checkIsDefined } from '@onekeyhq/shared/src/utils/assertUtils';
import networkUtils from '@onekeyhq/shared/src/utils/networkUtils';
import timerUtils from '@onekeyhq/shared/src/utils/timerUtils';
import type { IBatchCreateAccount } from '@onekeyhq/shared/types/account';

import localDb from '../../dbs/local/localDb';
import { buildDefaultAddAccountNetworks } from '../ServiceAccount/defaultNetworkAccountsConfig';
import ServiceBase from '../ServiceBase';

import type { IAccountDeriveTypes } from '../../vaults/types';

export type IBatchCreateAccountProgressInfo = {
  totalCount: number;
  progressTotal: number;
  progressCurrent: number;
  createdCount: number;
};

export type IBatchBuildAccountsBaseParams = {
  walletId: string;
  networkId: string;
  deriveType: IAccountDeriveTypes;
  skipDeviceCancel?: boolean;
  hideCheckingDeviceLoading?: boolean;
};
export type IBatchBuildAccountsParams = IBatchBuildAccountsBaseParams & {
  indexes: number[];
  excludedIndexes?: {
    [index: number]: true;
  };
  saveToDb?: boolean;
};

export type IBatchBuildAccountsNormalFlowParams =
  IBatchBuildAccountsBaseParams & {
    indexes: number[];
    saveToDb: boolean;
  };

type IAdvancedModeFlowParamsBase = {
  fromIndex: number;
  toIndex: number;
  excludedIndexes: {
    [index: number]: true;
  };
  saveToDb: boolean;
};
export type IBatchBuildAccountsAdvancedFlowParams =
  IBatchBuildAccountsBaseParams & IAdvancedModeFlowParamsBase;
export type IBatchBuildAccountsAdvancedFlowForAllNetworkParams = {
  walletId: string;
  customNetworks?: { networkId: string; deriveType: IAccountDeriveTypes }[];
  skipDeviceCancel?: boolean;
  hideCheckingDeviceLoading?: boolean;
} & IAdvancedModeFlowParamsBase;

@backgroundClass()
class ServiceBatchCreateAccount extends ServiceBase {
  constructor({ backgroundApi }: { backgroundApi: any }) {
    super({ backgroundApi });
  }

  networkAccountsCache: Partial<{
    [key: string]: IBatchCreateAccount;
  }> = {};

  progressInfo: IBatchCreateAccountProgressInfo | undefined;

  isCreateFlowCancelled = false;

  buildNetworkAccountCacheKey({
    walletId,
    networkId,
    deriveType,
    index,
  }: IBatchBuildAccountsBaseParams & {
    index: number;
  }) {
    let networkIdOrImpl = networkId;
    const impl = networkUtils.getNetworkImpl({ networkId });
    if ([IMPL_EVM].includes(impl)) {
      networkIdOrImpl = impl;
    }

    return `${walletId}_${networkIdOrImpl}_${deriveType}_${index}`;
  }

  @backgroundMethod()
  async clearNetworkAccountCache() {
    this.networkAccountsCache = {};
  }

  beforeStartFlow() {
    this.isCreateFlowCancelled = false;
    this.progressInfo = undefined;
  }

  async updateAccountExistsInDb({ account }: { account: IBatchCreateAccount }) {
    if (await localDb.getAccountSafe({ accountId: account.id })) {
      account.existsInDb = true;
    } else {
      account.existsInDb = false;
    }
  }

  @backgroundMethod()
  async prepareBatchCreate() {
    await this.clearNetworkAccountCache();
  }

  @backgroundMethod()
  @toastIfError()
  async startBatchCreateAccountsFlow(
    payload:
      | {
          mode: 'advanced';
          params: IBatchBuildAccountsAdvancedFlowParams;
        }
      | {
          mode: 'normal';
          params: IBatchBuildAccountsNormalFlowParams;
        },
  ) {
    this.beforeStartFlow();

    let indexes: number[] = [];
    let excludedIndexes: {
      [index: number]: true;
    } = {};
    const saveToDb: boolean | undefined = payload.params.saveToDb;
    if (payload.mode === 'advanced') {
      indexes = await this.buildIndexesByFromAndTo({
        fromIndex: payload.params?.fromIndex,
        toIndex: payload.params?.toIndex,
      });
      excludedIndexes = payload.params.excludedIndexes;
    }
    if (payload.mode === 'normal') {
      indexes = payload.params.indexes;
    }

    this.progressInfo = this.buildProgressInfo({
      indexes,
      excludedIndexes,
    });
    const result = await this.batchBuildAccounts({
      ...payload.params,
      indexes,
      excludedIndexes,
      saveToDb: true,
    });
    await this.emitBatchCreateDoneEvents({ saveToDb });
    await this.backgroundApi.serviceHardware.cancelByWallet({
      walletId: payload?.params?.walletId,
    });
    return result;
  }

  async buildDefaultNetworksForBatchCreate({
    walletId,
  }: {
    walletId: string;
  }): Promise<IBatchBuildAccountsBaseParams[]> {
    return buildDefaultAddAccountNetworks().map((item) => ({
      ...item,
      walletId,
    }));
  }

  async buildAllNetworksForBatchCreate({
    walletId,
  }: {
    walletId: string;
  }): Promise<IBatchBuildAccountsBaseParams[]> {
    let excludeNetworkIds = [
      getNetworkIdsMap().onekeyall,
      getNetworkIdsMap().ada, // too slow
      getNetworkIdsMap().lightning, // network connection required
      getNetworkIdsMap().tlightning,
      getNetworkIdsMap().dnx, // not support hd
    ];
    if (accountUtils.isHwWallet({ walletId })) {
      excludeNetworkIds = [
        getNetworkIdsMap().onekeyall,
        getNetworkIdsMap().ada, // too slow, destroy hw passpharse
        getNetworkIdsMap().lightning, // sign required
        getNetworkIdsMap().tlightning,
      ];
    }

    const { networks } = await this.backgroundApi.serviceNetwork.getAllNetworks(
      {
        excludeTestNetwork: true,
        excludeNetworkIds,
        uniqByImpl: true,
      },
    );

    const result: IBatchBuildAccountsBaseParams[] = [];
    for (const network of networks) {
      const networkId = network.id;
      const deriveItems =
        await this.backgroundApi.serviceNetwork.getDeriveInfoItemsOfNetwork({
          networkId,
        });
      for (const deriveItem of deriveItems) {
        const deriveType: IAccountDeriveTypes =
          deriveItem.value as IAccountDeriveTypes;
        result.push({
          walletId,
          networkId,
          deriveType,
        });
      }
    }
    return result;
  }

  @backgroundMethod()
  async addDefaultNetworkAccounts({
    walletId,
    indexedAccountId,
    skipDeviceCancel,
    hideCheckingDeviceLoading,
    customNetworks,
  }: {
    walletId: string | undefined;
    indexedAccountId: string | undefined;
    skipDeviceCancel?: boolean;
    hideCheckingDeviceLoading?: boolean;
    customNetworks?: { networkId: string; deriveType: IAccountDeriveTypes }[];
  }): Promise<
    | {
        addedAccounts: {
          networkId: string;
          deriveType: IAccountDeriveTypes;
        }[];
      }
    | undefined
  > {
    if (!walletId) {
      return;
    }
    if (
      accountUtils.isHdWallet({
        walletId,
      }) ||
      accountUtils.isHwWallet({
        walletId,
      }) ||
      accountUtils.isQrWallet({
        walletId,
      })
    ) {
      if (!indexedAccountId) {
        throw new Error('indexedAccountId is required');
      }
      const index = accountUtils.parseIndexedAccountId({
        indexedAccountId,
      }).index;
      return this.startBatchCreateAccountsFlowForAllNetwork({
        walletId,
        fromIndex: index,
        toIndex: index,
        excludedIndexes: {},
        saveToDb: true,
        customNetworks: customNetworks || [],
        skipDeviceCancel,
        hideCheckingDeviceLoading,
      });
    }
  }

  @backgroundMethod()
  @toastIfError()
  async startBatchCreateAccountsFlowForAllNetwork(
    params: IBatchBuildAccountsAdvancedFlowForAllNetworkParams,
  ) {
    this.beforeStartFlow();

    // let networksParams: IBatchBuildAccountsBaseParams[] =
    //   await this.buildAllNetworksForBatchCreate({
    //     walletId: params.walletId,
    //   });

    let networksParams: IBatchBuildAccountsBaseParams[] =
      await this.buildDefaultNetworksForBatchCreate({
        walletId: params.walletId,
      });

    if (params.customNetworks?.length) {
      networksParams = networksParams.concat(
        params.customNetworks.map((item) => ({
          ...item,
          walletId: params.walletId,
        })),
      );
    }

    const { saveToDb } = params;
    const indexes = await this.buildIndexesByFromAndTo({
      fromIndex: params?.fromIndex,
      toIndex: params?.toIndex,
    });
    const excludedIndexes = params.excludedIndexes;

    const progressInfo = this.buildProgressInfo({
      indexes,
      excludedIndexes,
    });
    progressInfo.totalCount *= networksParams.length;
    progressInfo.progressTotal *= networksParams.length;
    this.progressInfo = progressInfo;

    const addedAccounts: Array<{
      networkId: string;
      deriveType: IAccountDeriveTypes;
    }> = [];

    for (const networkParams of networksParams) {
      this.checkIfCancelled({ saveToDb });
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { accountsForCreate } = await this.batchBuildAccounts({
          ...params,
          ...networkParams,
          indexes,
          excludedIndexes,
          saveToDb: true,
        });
        addedAccounts.push({
          networkId: networkParams.networkId,
          deriveType: networkParams.deriveType,
        });
      } catch (error: any) {
        // Some high priority errors need to interrupt the process
        if (accountUtils.isHwWallet({ walletId: params.walletId })) {
          if (isHardwareInterruptErrorByCode({ error })) {
            throw error;
          }
          // Unplug device?
          if (
            isHardwareErrorByCode({
              error,
              code: HardwareErrorCode.DeviceNotFound,
            })
          ) {
            throw error;
          }
        }
      }
    }

    await this.emitBatchCreateDoneEvents({ saveToDb });
    await this.backgroundApi.serviceHardware.cancelByWallet({
      walletId: params?.walletId,
    });
    return { addedAccounts };
  }

  async emitBatchCreateDoneEvents({ saveToDb }: { saveToDb?: boolean } = {}) {
    if (saveToDb) {
      appEventBus.emit(EAppEventBusNames.BatchCreateAccount, {
        totalCount: checkIsDefined(this.progressInfo).totalCount,
        createdCount: checkIsDefined(this.progressInfo).createdCount,
        progressTotal: checkIsDefined(this.progressInfo).progressTotal,
        progressCurrent: checkIsDefined(this.progressInfo).progressTotal,
      });
      await timerUtils.wait(600);
      appEventBus.emit(EAppEventBusNames.AccountUpdate, undefined);
      void this.backgroundApi.serviceCloudBackup.requestAutoBackup();
    }
  }

  @backgroundMethod()
  async cancelBatchCreateAccountsFlow() {
    this.isCreateFlowCancelled = true;
    this.progressInfo = undefined;
  }

  checkIfCancelled({ saveToDb }: { saveToDb: boolean | undefined }) {
    if (saveToDb && this.isCreateFlowCancelled) {
      throw new Error('Batch Create Accounts Cancelled');
    }
  }

  @backgroundMethod()
  async buildIndexesByFromAndTo({
    fromIndex,
    toIndex,
    indexes,
  }: {
    fromIndex?: number;
    toIndex?: number;
    indexes?: number[];
  }) {
    if (!indexes) {
      if (isNil(fromIndex)) {
        throw new Error('fromIndex is required');
      }
      if (isNil(toIndex)) {
        throw new Error('toIndex is required');
      }
      // eslint-disable-next-line no-param-reassign
      indexes = range(fromIndex, toIndex + 1);
    }
    if (!indexes || !indexes?.length) {
      throw new Error('indexes is required');
    }
    return indexes;
  }

  buildProgressInfo({
    indexes,
    excludedIndexes,
  }: {
    indexes: number[];
    excludedIndexes?: {
      [index: number]: true;
    };
  }): IBatchCreateAccountProgressInfo {
    const totalCount = indexes.length;
    const progressTotal =
      totalCount - Object.values(excludedIndexes || {}).filter(Boolean).length;
    const progressCurrent = 0;
    const createdCount = 0;
    return {
      totalCount,
      progressTotal,
      progressCurrent,
      createdCount,
    };
  }

  @backgroundMethod()
  @toastIfError()
  async batchBuildAccounts({
    walletId,
    networkId,
    deriveType,
    indexes,
    excludedIndexes,
    saveToDb,
    hideCheckingDeviceLoading,
  }: IBatchBuildAccountsParams): Promise<{
    accountsForCreate: IBatchCreateAccount[];
  }> {
    if (networkUtils.isAllNetwork({ networkId })) {
      throw new Error('Batch Create Accounts ERROR:  All network not support');
    }
    if (!this.progressInfo && saveToDb) {
      throw new Error('Batch Create Accounts ERROR:  progressInfo is required');
    }

    const accountsForCreate: IBatchCreateAccount[] = [];

    const indexesForRebuild: number[] = [];

    const processAccountForCreate = async ({
      key,
      accountForCreate,
    }: {
      key: string;
      accountForCreate: IBatchCreateAccount;
    }) => {
      this.checkIfCancelled({ saveToDb });
      await this.updateAccountExistsInDb({ account: accountForCreate });
      this.networkAccountsCache[key] = accountForCreate;
      accountsForCreate.push(accountForCreate);
      if (saveToDb) {
        if (!accountForCreate.existsInDb) {
          this.checkIfCancelled({ saveToDb });
          await this.backgroundApi.serviceAccount.addBatchCreatedHdOrHwAccount({
            walletId,
            networkId,
            account: accountForCreate,
          });
          checkIsDefined(this.progressInfo).createdCount += 1;
          await timerUtils.wait(100);
        }
        checkIsDefined(this.progressInfo).progressCurrent += 1;
        appEventBus.emit(EAppEventBusNames.BatchCreateAccount, {
          totalCount: checkIsDefined(this.progressInfo).totalCount,
          createdCount: checkIsDefined(this.progressInfo).createdCount,
          progressTotal: checkIsDefined(this.progressInfo).progressTotal,
          progressCurrent: checkIsDefined(this.progressInfo).progressCurrent,
          networkId,
          deriveType,
        });
        await timerUtils.wait(100);
      }
    };

    // for loop indexes
    for (const index of indexes) {
      this.checkIfCancelled({ saveToDb });
      if (excludedIndexes?.[index] === true) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const key = this.buildNetworkAccountCacheKey({
        walletId,
        networkId,
        deriveType,
        index,
      });
      const cacheAccount = this.networkAccountsCache[key];
      if (cacheAccount) {
        this.checkIfCancelled({ saveToDb });
        await processAccountForCreate({
          key,
          accountForCreate: cacheAccount,
        });
      } else {
        indexesForRebuild.push(index);
      }
    }

    if (indexesForRebuild.length) {
      const indexesChunks = chunk(indexesForRebuild, 10);
      for (const indexesForRebuildChunk of indexesChunks) {
        this.checkIfCancelled({ saveToDb });
        const { vault, accounts } =
          await this.backgroundApi.serviceAccount.prepareHdOrHwAccounts({
            walletId,
            networkId,
            deriveType,
            indexes: indexesForRebuildChunk,
            indexedAccountId: undefined,
            skipDeviceCancel: true, // always skip cancel for batch create
            hideCheckingDeviceLoading,
          });
        const networkInfo = await vault.getNetworkInfo();
        for (const account of accounts) {
          this.checkIfCancelled({ saveToDb });
          if (isNil(account.pathIndex)) {
            throw new Error(
              'batchBuildNetworkAccounts ERROR: pathIndex is required',
            );
          }
          if (excludedIndexes?.[account.pathIndex] === true) {
            // eslint-disable-next-line no-continue
            continue;
          }
          const key = this.buildNetworkAccountCacheKey({
            walletId,
            networkId,
            deriveType,
            index: account.pathIndex,
          });
          this.checkIfCancelled({ saveToDb });

          const addressDetail = await vault?.buildAccountAddressDetail({
            account,
            networkId,
            networkInfo,
          });
          const accountForCreate: IBatchCreateAccount = {
            ...account,
            addressDetail,
            existsInDb: false,
          };
          accountForCreate.address =
            addressDetail?.displayAddress ||
            addressDetail?.address ||
            accountForCreate.address;
          this.checkIfCancelled({ saveToDb });

          await processAccountForCreate({
            key,
            accountForCreate,
          });
        }
      }
    }
    return { accountsForCreate };
  }
}

export default ServiceBatchCreateAccount;
