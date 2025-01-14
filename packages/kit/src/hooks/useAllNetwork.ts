import { useRef, useState } from 'react';

import { isEmpty } from 'lodash';

import type { IDBWallet } from '@onekeyhq/kit-bg/src/dbs/local/types';
import { POLLING_DEBOUNCE_INTERVAL } from '@onekeyhq/shared/src/consts/walletConsts';
import {
  IMPL_ALLNETWORKS,
  getEnabledNFTNetworkIds,
} from '@onekeyhq/shared/src/engine/engineConsts';
import { waitAsync } from '@onekeyhq/shared/src/utils/promiseUtils';
import type { IServerNetwork } from '@onekeyhq/shared/types';
import type { INetworkAccount } from '@onekeyhq/shared/types/account';

import backgroundApiProxy from '../background/instance/backgroundApiProxy';

import { usePromiseResult } from './usePromiseResult';

const enableNFTNetworkIds = getEnabledNFTNetworkIds();

function useAllNetworkRequests<T>(params: {
  account: INetworkAccount | undefined;
  network: IServerNetwork | undefined;
  wallet: IDBWallet | undefined;
  allNetworkRequests: ({
    accountId,
    networkId,
  }: {
    accountId: string;
    networkId: string;
  }) => Promise<T | undefined>;
  clearAllNetworkData: () => void;
  abortAllNetworkRequests?: () => void;
  isNFTRequests?: boolean;
  disabled?: boolean;
  interval?: number;
  shouldAlwaysFetch?: boolean;
}) {
  const {
    account,
    network,
    wallet,
    allNetworkRequests,
    abortAllNetworkRequests,
    clearAllNetworkData,
    isNFTRequests,
    disabled,
    interval = 0,
    shouldAlwaysFetch,
  } = params;
  const allNetworkDataInit = useRef(false);
  const isFetching = useRef(false);
  const [isEmptyAccount, setIsEmptyAccount] = useState(false);

  const { run, result } = usePromiseResult(
    async () => {
      if (disabled) return;
      if (isFetching.current) return;
      if (!account || !network || !wallet) return;
      if (!network.isAllNetworks) return;

      isFetching.current = true;

      if (!allNetworkDataInit.current) {
        clearAllNetworkData();
      }

      abortAllNetworkRequests?.();

      const allAccounts = (
        await backgroundApiProxy.serviceAccount.getAccountsInSameIndexedAccountId(
          {
            indexedAccountId: account.indexedAccountId ?? '',
          },
        )
      ).filter((a) => a.impl !== IMPL_ALLNETWORKS);

      if (!allAccounts || isEmpty(allAccounts)) {
        setIsEmptyAccount(true);
        isFetching.current = false;
        return;
      }

      const concurrentNetworks = new Set<string>();
      const sequentialNetworks = new Set<string>();
      let resp: Array<T> = [];

      for (const a of allAccounts) {
        const networks = (
          await backgroundApiProxy.serviceNetwork.getNetworksByImpls({
            impls: [a.impl],
          })
        ).networks.filter((i) => !i.isTestnet);

        for (const n of networks) {
          if (!isNFTRequests || enableNFTNetworkIds.includes(n.id)) {
            const networkData = { accountId: a.id, networkId: n.id };
            if (n.backendIndex) {
              concurrentNetworks.add(JSON.stringify(networkData));
            } else {
              sequentialNetworks.add(JSON.stringify(networkData));
            }
          }
        }
      }

      if (concurrentNetworks.size === 0 && sequentialNetworks.size === 0) {
        setIsEmptyAccount(true);
        isFetching.current = false;
        return;
      }

      setIsEmptyAccount(false);

      if (allNetworkDataInit.current) {
        const allNetworks = [
          ...Array.from(sequentialNetworks),
          ...Array.from(concurrentNetworks),
        ];

        const requests = allNetworks.map((networkDataString) => {
          const { accountId, networkId } = JSON.parse(networkDataString);
          return allNetworkRequests({ accountId, networkId });
        });

        try {
          resp = (await Promise.all(requests)).filter(Boolean);
        } catch (e) {
          console.error(e);
          // pass
        }
      } else {
        // 处理并发请求的网络
        const concurrentRequests = Array.from(concurrentNetworks).map(
          (networkDataString) => {
            const { accountId, networkId } = JSON.parse(networkDataString);
            console.log(
              'concurrentRequests: =====>>>>>: ',
              accountId,
              networkId,
            );
            return allNetworkRequests({ accountId, networkId });
          },
        );
        try {
          await Promise.all(concurrentRequests);
        } catch (e) {
          console.error(e);
          // pass
        }

        // 处理顺序请求的网络
        for (const networkDataString of sequentialNetworks) {
          const { accountId, networkId } = JSON.parse(networkDataString);
          try {
            await allNetworkRequests({ accountId, networkId });
          } catch (e) {
            console.error(e);
            // pass
          }
          await waitAsync(interval);
        }
      }

      allNetworkDataInit.current = true;
      isFetching.current = false;

      return resp;
    },
    [
      disabled,
      account,
      network,
      wallet,
      abortAllNetworkRequests,
      clearAllNetworkData,
      isNFTRequests,
      allNetworkRequests,
      interval,
    ],
    {
      debounced: POLLING_DEBOUNCE_INTERVAL,
      overrideIsFocused: (isPageFocused) =>
        isPageFocused || !!shouldAlwaysFetch,
    },
  );

  return {
    run,
    result,
    isEmptyAccount,
  };
}

export { useAllNetworkRequests };
