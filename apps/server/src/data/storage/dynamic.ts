import { type StorageInfo, type StorageLoad, sumUp } from '@dashdot/common';
import * as si from 'systeminformation';
import { CONFIG } from '../../config';
import { syncDevMapper } from '../../setup';
import { getStaticServerInfo } from '../../static-info';
import { fromHost, PLATFORM_IS_WINDOWS } from '../../utils';
import { getEnhancedBlocks } from './blocks';

type Block = si.Systeminformation.BlockDevicesData;
type Size = si.Systeminformation.FsSizeData;

export class DynamicStorageMapper {
  private validSizes: Size[];

  constructor(
    private hostWin32: boolean,
    private layout: StorageInfo,
    private blocks: Block[],
    private sizes: Size[],
  ) {
    this.validSizes = this.getValidSizes();
  }

  // Setup local values
  private getValidSizes() {
    return this.sizes.filter(
      ({ mount, type }) =>
        (this.hostWin32 || mount.startsWith(fromHost('/'))) &&
        !CONFIG.fs_type_filter.includes(type),
    );
  }

  // Helpers
  private getBlocksForDisks(disks: StorageInfo[number]['disks']) {
    return this.blocks.filter(({ name, device }) =>
      disks.some((d) =>
        this.hostWin32
          ? d.device === device
          : name.startsWith(d.device) ||
            device === `/dev/${d.device}` ||
            device === d.device,
      ),
    );
  }

  private getBlocksForRaid(raidLabel?: string, raidName?: string) {
    return this.blocks.filter(
      ({ label, name }) =>
        (raidLabel && label.startsWith(raidLabel)) ||
        (raidName && name.startsWith(raidName)),
    );
  }

  private getBlocksForXfs(parts: Block[]) {
    return this.blocks.filter(
      ({ uuid, type, fsType }) =>
        type === 'md' &&
        fsType === 'xfs' &&
        parts.some((part) => part.uuid === uuid),
    );
  }

  private getBlocksForLvm(deviceParts: Block[]) {
    const hasLvm = deviceParts.some(
      ({ fsType, type }) => fsType === 'LVM2_member' || type === 'lvm',
    );
    if (!hasLvm) return [];

    const lvmBlocks = this.blocks.filter(({ type }) => type === 'lvm');

    // If any LVM blocks are explicitly mapped to one of the deviceParts, return only those
    const directlyMapped = lvmBlocks.filter((lvm) =>
      deviceParts.some(
        (p) =>
          lvm.device === p.device ||
          lvm.device === `/dev/${p.name}` ||
          (p.device && lvm.device?.startsWith(p.device)),
      ),
    );
    if (directlyMapped.length > 0) {
      return directlyMapped;
    }

    // Check if any other disk in the storage layout also has an LVM member
    const otherDisksHaveLvm = this.layout.some(
      (item) =>
        !item.disks.some((d) =>
          deviceParts.some((p) => p.name.startsWith(d.device)),
        ) &&
        this.blocks.some(
          (b) =>
            item.disks.some((d) => b.name.startsWith(d.device)) &&
            (b.fsType === 'LVM2_member' || b.type === 'lvm'),
        ),
    );

    // If only this disk layout item has LVM, all LVM blocks belong to it
    if (!otherDisksHaveLvm) {
      return lvmBlocks;
    }

    return lvmBlocks;
  }

  private getBlocksForCrypt(deviceParts: Block[]) {
    const cryptParts = deviceParts.filter(
      ({ fsType, type }) => fsType === 'crypto_LUKS' || type === 'crypt',
    );
    if (cryptParts.length === 0) return [];

    return this.blocks.filter(
      (b) =>
        b.type === 'crypt' &&
        (deviceParts.some(
          (p) =>
            b.device === p.device ||
            b.device === `/dev/${p.name}` ||
            (p.uuid && b.name.includes(p.uuid)),
        ) ||
          cryptParts.length > 0),
    );
  }

  private isRootMount(mount: string) {
    return (
      !this.hostWin32 &&
      (mount === fromHost('/') || mount.startsWith(fromHost('/boot')))
    );
  }

  private isHostMount(mount: string) {
    return (
      !this.hostWin32 &&
      (this.isRootMount(mount) || mount.startsWith(fromHost('/home')))
    );
  }

  // Get size of the mounts of the partitions/disks of device
  private getSizeForBlocks(
    deviceBlocks: Block[],
    diskSize: number,
    isHost: boolean,
  ) {
    const hasLvmOrCrypt = deviceBlocks.some(
      ({ fsType, type }) =>
        fsType === 'LVM2_member' ||
        fsType === 'crypto_LUKS' ||
        type === 'lvm' ||
        type === 'crypt',
    );

    const sizes = this.validSizes.filter((size) =>
      deviceBlocks.some((block) => {
        const matchedByMount =
          size.mount &&
          (block.mount === size.mount ||
            size.mount.endsWith(`dev-disk-by-uuid-${block.uuid}`));
        const matchedByDevice =
          (block.device && size.fs.startsWith(block.device)) ||
          size.fs === `/dev/${block.name}` ||
          size.fs === `/dev/mapper/${block.name}` ||
          size.fs.endsWith(`/${block.name}`);
        const matchedByHost =
          isHost &&
          (this.isRootMount(size.mount) ||
            (hasLvmOrCrypt &&
              (this.isHostMount(size.mount) ||
                size.fs.startsWith('/dev/mapper/') ||
                size.fs.startsWith('/dev/dm-'))));

        return matchedByMount || matchedByDevice || matchedByHost;
      }),
    );

    // Deduplicate sizes that point to the exact same filesystem device
    const uniqueSizes = sizes.filter(
      (s, index, self) =>
        index ===
        self.findIndex((other) => other.fs === s.fs && other.fs !== ''),
    );

    if (uniqueSizes.length === 0) {
      return -1;
    }

    const calculatedSize = sumUp(uniqueSizes, 'used');

    if (hasLvmOrCrypt) {
      return calculatedSize;
    }

    const totalAvailable = sumUp(uniqueSizes, 'size');
    const preAllocated = Math.max(0, diskSize - totalAvailable);

    return calculatedSize + preAllocated;
  }

  public getMappedLayout() {
    return this.layout.map(({ size, disks, virtual, raidLabel, raidName }) => {
      if (virtual) {
        const size = this.sizes.find((s) => s.fs === disks[0]?.device);
        return size?.used ?? 0;
      }

      const deviceParts = this.getBlocksForDisks(disks);
      const lvmParts = this.getBlocksForLvm(deviceParts);
      const cryptParts = this.getBlocksForCrypt(deviceParts);

      const allBlocks = deviceParts
        .concat(this.getBlocksForRaid(raidLabel, raidName))
        .concat(this.getBlocksForXfs(deviceParts))
        .concat(lvmParts)
        .concat(cryptParts);

      const deviceBlocks = allBlocks.filter(
        (b, i, arr) => arr.findIndex((x) => x.name === b.name) === i,
      );

      const isHost = deviceBlocks.some(({ mount }) => this.isRootMount(mount));

      return this.getSizeForBlocks(deviceBlocks, size, isHost);
    });
  }
}

export default async (): Promise<StorageLoad> => {
  const svInfo = getStaticServerInfo();
  if (CONFIG.running_in_docker) {
    await syncDevMapper();
  }
  const [sizes, blocks] = await Promise.all([si.fsSize(), getEnhancedBlocks()]);

  return new DynamicStorageMapper(
    PLATFORM_IS_WINDOWS,
    svInfo.storage,
    blocks,
    sizes,
  ).getMappedLayout();
};
