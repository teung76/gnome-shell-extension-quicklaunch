/* vim: ts=4 sw=4
 */

const GETTEXT_DOMAIN = "QuickLaunch-extension";

import Atk from 'gi://Atk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as FileUtils from 'resource:///org/gnome/shell/misc/fileUtils.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const AppsPath = GLib.get_home_dir() + '/.local/share/gnome-shell/quicklaunch';
const AppsPaths = [ GLib.get_home_dir() + '/.local/user/apps', AppsPath ];

const IndicatorName = 'QuickLaunch';

const PopupGiconMenuItem = GObject.registerClass(
class PopupGiconMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, gIcon, params) {
        super._init(params);

        this.label = new St.Label({ text: text });
        this._icon = new St.Icon({
                gicon: gIcon,
                style_class: 'popup-menu-icon'
            });
        this.actor.add_child(this._icon);
        this.actor.add_child(this.label);
    }
});

/**
 * QuickLaunch Object
 */
const QuickLaunch = GObject.registerClass(
class QuickLaunch extends PanelMenu.Button {
    _init(metadata, params) {
        super._init(0.0, _(IndicatorName));
        this.actor.accessible_role = Atk.Role.TOGGLE_BUTTON;

        this._icon = new St.Icon({ icon_name: 'system-run-symbolic', style_class: 'system-status-icon' }); 
        this.actor.add_actor(this._icon);
        this.actor.add_style_class_name('panel-status-button');

        this.connect('destroy', () => this._onDestroy());
        this._setupDirectory();
        this._setupAppMenuItems();
        this._setupNewEntryDialog();
//        this._setupDirectoryMonitor();
    }

    _onDestroy() {
//        this._monitor.cancel();
        if (this._appDirectoryTimeoutId > 0)
            GLib.Source.remove(this._appDirectoryTimeoutId);
    }

    /**
     * create dir unless exists
     */
    _setupDirectory() {
        let dir = Gio.file_new_for_path(AppsPath);
        if (!dir.query_exists(null)) {
            console.log('create dir ' + AppsPath );
            dir.make_directory_with_parents(null);
        }
        this._appDirectory = dir;
    }

    /**
     * reload the menu
     */
    _reloadAppMenu() {
        this.menu.removeAll();
        this._setupAppMenuItems();
        this._setupNewEntryDialog();
    }

    /**
     * change directory monitor, see placeDisplay.js
     */
    _setupDirectoryMonitor() {
        if (!this._appDirectory.query_exists(null))
            return;
        this._monitor = this._appDirectory.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._appDirectoryTimeoutId = 0;
        this._monitor.connect('changed', () => {
            if (this._appDirectoryTimeoutId > 0)
                return;
            /* Defensive event compression */
            this._appDirectoryTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._appDirectoryTimeoutId = 0;
                this._reloadAppMenu();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /**
     * setup menu items for all desktop files
     */
    _setupAppMenuItems(path) {
        for (let path in AppsPaths)
            this._createDefaultApps(AppsPaths[path]);
    }

    /**
     * load desktop files from a directory
     */
    _createDefaultApps(path) {
        let _appsDir = Gio.file_new_for_path(path);
        if (!_appsDir.query_exists(null)) {
            console.log('App path ' + path + ' could not be opened!');
            return;
        }

        let fileEnum;
        let file, info;
        let i = 0;
        try {
            fileEnum = _appsDir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            console.logError('' + e);
            return;
        }

        // add menu entry for each file
        while ((info = fileEnum.next_file(null)) != null) {
            let fileType = info.get_file_type();
            if (fileType == Gio.FileType.DIRECTORY)
                continue;
            let name = info.get_name();
            if( name.indexOf('.desktop') > -1) {
                let desktopPath =  GLib.build_filenamev([path, name]);
                this._addAppItem(desktopPath);
                i++;
            }
        }
        fileEnum.close(null);
    }

    /**
     * add menu item to popup
     */
    _addAppItem(desktopPath) {
        // from http://www.roojs.com/seed/gir-1.2-gtk-3.0/gjs/
        let appInfo = Gio.DesktopAppInfo.new_from_filename(desktopPath);
        if (!appInfo) {
            console.log('App for desktop file ' + desktopPath + ' could not be loaded!');
            return null;
        }

        let menuItem = this._createAppItem(appInfo, function(w, ev) {
            if(!appInfo.launch([], null)) {
                console.log('Failed to launch ' + appInfo.get_commandline);
            }
        });

/* // Util.lowerBound not exist in gnome shell 45
        // alphabetically sort list by app name
        let sortKey = appInfo.get_name() || desktopPath;
        let pos = Util.lowerBound(this.menu._getMenuItems(), sortKey, function (a,b) {
            if (String(a.label.text).toUpperCase() > String(b).toUpperCase())
                return 0;
            else
                return -1;
        });
        this.menu.addMenuItem(menuItem, pos);*/
        this.menu.addMenuItem(menuItem);
        return menuItem;
    }

    /**
     * create popoup menu item with callback
     */
    _createAppItem(appInfo, callback) {
        let menuItem = new PopupGiconMenuItem(appInfo.get_name(), appInfo.get_icon(), {});
        menuItem.connect('activate', (menuItem, event) => {
                    callback(menuItem, event);
        });

        return menuItem;
    }

    /**
     * add "new app"-dialog link to popup menu
     */
    _setupNewEntryDialog() {
        let entryCreator = new DesktopEntryCreator();
        if (! entryCreator.hasEditor()) {
            console.log('gnome-desktop-item-edit is not installed!');
            return;
        }
        let item = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(item);
        item = new PopupMenu.PopupMenuItem(_("Add new launcher..."));
        item.connect('activate', () => {
            if (!this._appDirectory.query_exists(null))
                return;
            entryCreator.createEntry(AppsPath);
        });
        this.menu.addMenuItem(item);
    }
});

/**
 * DesktopEntryCreator
 * 
 * use gnome-dekstop-item-edit to create a new desktop entry file
 */
class DesktopEntryCreator {
    constructor() {
        let gdie = Gio.file_new_for_path('/usr/bin/gnome-desktop-item-edit');
	this._existEditor = gdie.query_exists(null);
    }

    hasEditor() {
        return this._existEditor;
    }

    createEntry(destination) {
        Util.trySpawn( ['gnome-desktop-item-edit', this._getNewEntryName(destination) ]);
    }

    _getNewEntryName(destination) {
        return GLib.build_filenamev([destination, this._createUUID() + '.desktop']);
    }

    /*
     * thanks to stackoverflow:
     */
    _createUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
            return v.toString(16);
        });
    }
};

/**
 * Extension Setup
 */
export default class QuickLaunchExtension extends Extension {
    enable() {
        this._indicator = new QuickLaunch();
        Main.panel.addToStatusArea(_(IndicatorName), this._indicator, 1, "left");
    }

    disable() {
        this._indicator.destroy();
        delete this._indicator;
    }
}
