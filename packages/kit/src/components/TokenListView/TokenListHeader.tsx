import { debounce } from 'lodash';
import { useIntl } from 'react-intl';

import { SizableText, Stack, XStack } from '@onekeyhq/components';
import {
  SEARCH_DEBOUNCE_INTERVAL,
  SEARCH_KEY_MIN_LENGTH,
} from '@onekeyhq/shared/src/consts/walletConsts';
import { ETranslations } from '@onekeyhq/shared/src/locale';
import type { IAccountToken } from '@onekeyhq/shared/types/token';

import {
  useSearchKeyAtom,
  useTokenListActions,
} from '../../states/jotai/contexts/tokenList';
import { ListToolToolBar } from '../ListToolBar';

type IProps = {
  filteredTokens: IAccountToken[];
  tableLayout?: boolean;
};

function TokenListHeader({ tableLayout, filteredTokens }: IProps) {
  const intl = useIntl();
  const { updateSearchKey } = useTokenListActions().current;
  const [searchKey] = useSearchKeyAtom();

  return (
    <Stack testID="Wallet-Token-List-Header">
      <ListToolToolBar
        searchProps={{
          onChangeText: debounce(
            (text) => updateSearchKey(text),
            SEARCH_DEBOUNCE_INTERVAL,
          ),
          searchResultCount:
            searchKey && searchKey.length >= SEARCH_KEY_MIN_LENGTH
              ? filteredTokens.length
              : 0,
        }}
      />

      {tableLayout ? (
        <XStack px="$5" py="$2" space="$3">
          <XStack
            flexGrow={1}
            flexBasis={0}
            space={89}
            spaceDirection="horizontal"
          >
            <SizableText
              flexGrow={1}
              flexBasis={0}
              color="$textSubdued"
              size="$headingSm"
            >
              {intl.formatMessage({ id: ETranslations.global_asset })}
            </SizableText>
            <SizableText
              flexGrow={1}
              flexBasis={0}
              color="$textSubdued"
              size="$headingSm"
            >
              {intl.formatMessage({ id: ETranslations.global_balance })}
            </SizableText>
          </XStack>
          <Stack w="$8" />
          <XStack flexGrow={1} flexBasis={0}>
            <SizableText
              flexGrow={1}
              flexBasis={0}
              color="$textSubdued"
              size="$headingSm"
            >
              {intl.formatMessage({ id: ETranslations.global_price })}
            </SizableText>
            <SizableText
              flexGrow={1}
              flexBasis={0}
              textAlign="right"
              color="$textSubdued"
              size="$headingSm"
            >
              {intl.formatMessage({ id: ETranslations.global_value })}
            </SizableText>
          </XStack>
        </XStack>
      ) : null}
    </Stack>
  );
}

export { TokenListHeader };
