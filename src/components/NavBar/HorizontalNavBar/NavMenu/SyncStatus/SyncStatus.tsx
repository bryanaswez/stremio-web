import React from 'react';
import classnames from 'classnames';
import Icon from '@stremio/stremio-icons/react';
import { useSync } from 'stremio/common/Sync';
import styles from './styles.less';

type Props = {
    className?: string,
};

// Shows whether this device is connected to your other devices.
const SyncStatus = ({ className }: Props) => {
    const { available, signedIn, status, deviceName, devices } = useSync();

    if (!available) return null;

    let state: 'connected' | 'connecting' | 'offline';
    let title: string;
    let detail: string | null = null;

    if (!signedIn) {
        state = 'offline';
        title = 'Sign in to sync your devices';
    } else if (status.state === 'connected') {
        state = 'connected';
        title = `Synced as ${deviceName}`;
        detail = devices.length > 0 ?
            `Also online: ${devices.map((device) => device.name).join(', ')}`
            :
            'No other devices online';
    } else if (status.state === 'waiting') {
        state = 'offline';
        title = 'Can\'t reach the sync relay';
        detail = 'Retrying automatically';
    } else {
        state = 'connecting';
        title = 'Connecting to your devices…';
    }

    return (
        <div className={classnames(className, styles['sync-status-container'])} role={'status'}>
            <Icon className={styles['icon']} name={'cloud-sync'} />
            <div className={styles['details']}>
                <div className={styles['title']}>
                    <span className={classnames(styles['dot'], styles[state])} />
                    {title}
                </div>
                {
                    detail !== null ?
                        <div className={styles['detail']}>{detail}</div>
                        :
                        null
                }
            </div>
        </div>
    );
};

export default SyncStatus;
