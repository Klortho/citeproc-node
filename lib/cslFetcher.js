/*
    ***** BEGIN LICENSE BLOCK *****
    
    This file is part of the citeproc-node Server.
    
    Copyright © 2010 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/
/*
  cslFetcher object members:
    - cslPath - path to the CSL directory; from the config; defaults to './csl'
    - cslDir  - object representing the directory
    - cslShortNames - hash whose keys are the base part of the filenames of the
      .csl files in the CSL directory.  Values are the boolean `true`.
    - cslDependentDir - object representing the dependent subdirectory of the CSL 
      directory.
    - cslDependentShortNames - hash of the base names of the dependent style files.
      Unlike cslShortNames, the values here are either:
        - `true` - dependency not yet resolved
        - a string - the name of the style that this one depends on
*/

var fs = require('fs');
var http = require('http');
var url = require('url');
var jsdom = require('jsdom');
var cslFetcher = {
    '_cache':{}
};
var log = zcite.log;

/**
 * Initialize cslFetcher by synchronously reading the styles we have
 * @param  {object} config Hash with localesPath and cslPath
 * @return {bool}   returns true when finished
 */
cslFetcher.init = function(config){
    if (typeof config == 'undefined'){
        config = {
            "localesPath" : "./csl-locales",
            "cslPath" : "./csl"
        };
    }
    
    var dir, shortNames, len, i, filename;

    // Record the short names that we have independent styles for.  These are
    // .csl files in the ./csl directory (by default).
    cslFetcher.cslPath = config.cslPath;
    dir = cslFetcher.cslDir = fs.readdirSync(cslFetcher.cslPath);
    shortNames = cslFetcher.cslShortNames = {};
    len = dir.length
    for (i = 0; i < len; i++) {
        filename = dir[i];
        if (filename.substr(-4) == '.csl') {
            shortNames[filename.slice(0, -4)] = true;
        }
    }
    //log.silly("cslFetcher.cslShortNames = %j", cslFetcher.cslShortNames);

    // Record the short names that we have dependent styles for.  These are
    // .csl files in the ./csl/dependent directory.
    dir = cslFetcher.cslDependentDir = fs.readdirSync(cslFetcher.cslPath + '/dependent');
    shortNames = cslFetcher.cslDependentShortNames = {};
    var len = dir.length;
    for (i = 0; i < len; i++) {
        filename = dir[i];
        if (filename.substr(-4) == '.csl') {
            shortNames[filename.slice(0, -4)] = true;
        }
    }
    //log.silly("cslFetcher.cslDependentShortNames = %j", cslFetcher.cslDependentShortNames);

    return true;
};

cslFetcher.getCachedStyle = function(url){
    //log.error('cslFetcher.getCachedStyle');
    if(typeof this._cache[url] != 'undefined'){
        return this._cache[url];
    }
    else{
        return false;
    }
};

// This creates a URL object (http://nodejs.org/api/url.html) out of the
// style string.  If there is an error, it will return an error message as a
// simple string.
cslFetcher.processStyleIdentifier = function(style) {
    log.verbose("processStyleIdentifier");

    var urlObj = url.parse(style);
    
    // Here was the root cause of GitHub issue #8:
    if (typeof urlObj.host == "undefined" || !urlObj.host) {
        log.verbose("Style given as short name only");
        // Short name, treat as a zotero.org/styles url
        var newStyleUrl = 'http://www.zotero.org/styles/' + style;
        urlObj = url.parse(newStyleUrl);
        urlObj.shortName = style;
    }
    else if (urlObj.host == 'www.zotero.org'){
        log.verbose("Style given as a www.zotero.org URL");
        var pathname = urlObj.pathname;
        if (typeof pathname != 'string' ||
            pathname.substr(0, 8) != "/styles/") 
        {
            return "Invalid www.zotero.org URL for style: " + style;
        }
        urlObj.shortName = urlObj.pathname.substr(8);
    }
    else {
        // FIXME:  I guess this is an alternative URL to a style, but
        // it is not robustly handled.
        log.verbose("Style given as ???");
        if (typeof urlObj.pathname == 'string'){
            urlObj.shortName = urlObj.pathname.substr(8);
        }
    }
    return urlObj;
};

// This function runs under the async waterfall.  See citeServer.js for rules.
cslFetcher.resolveStyle = function(zcreq, callback) {
    log.verbose("cslFetcher.resolveStyle");
    var urlObj = zcreq.styleUrlObj;
    var shortName = urlObj.shortName;

    // FIXME:  for debugging, force the style name:
    //shortName = 'modern-language-association';
    
    // Check if independent style from zotero repo
    if ((typeof this.cslShortNames[shortName] != 'undefined') && 
        (this.cslShortNames[shortName] === true))
    {
        log.verbose("Independent style");
        callback(null);
        return;
    }
    
    // Check if dependent file from zotero repo
    else if (typeof this.cslDependentShortNames[shortName] != 'undefined') {
        log.verbose("Dependent style");
        
        if (typeof cslFetcher.cslDependentShortNames[shortName] == "string"){
            var parentStyle = cslFetcher.cslDependentShortNames[shortName];
            zcreq.styleUrlObj = cslFetcher.processStyleIdentifier(parentStyle);
            callback(null);
            return;
        }
        
        // Dependent style we haven't resolved before
        else {
            var filename = this.cslPath + '/dependent/' + shortName + '.csl';
            log.verbose("Resolving dependent style: " + filename);
            fs.readFile(filename, 'utf8', function(err, data){
                if (err) {
                    callback(err);
                    return;
                }
                var dependentcsl = data;
                var parentStyle = cslFetcher.readDependent(dependentcsl);
                if (parentStyle === false){
                    callback("Error resolving dependent style");
                    return;
                }
                log.verbose("Style " + shortName + " depends on " + parentStyle);
                cslFetcher.cslDependentShortNames[shortName] = parentStyle;

                log.verbose("Now processing " + parentStyle);
                var ret = cslFetcher.processStyleIdentifier(parentStyle);
                if (typeof ret === "string") {  // error
                    callback(ret);
                    return;
                }
                zcreq.styleUrlObj = cslFetcher.processStyleIdentifier(parentStyle);
                callback(null);
                return;
            });
        }
    }
    else {
        callback({statusCode: 404, message: "Style not found"});
        return;
    }
};

// This function runs under the async waterfall.  See citeServer.js for rules.
cslFetcher.fetchStyle = function(zcreq, callback){
    log.verbose("cslFetcher.fetchStyle");
    
    try {
      //// FIXME:  for debugging, force reading the style from a file
        if (zcreq.postedStyle) {
            log.verbose("Using the posted style");
            zcreq.cslXml = zcreq.postObj.styleXml;
            callback(null);
            return;
        }

        else if (zcreq.styleUrlObj.host == 'www.zotero.org') {
            log.verbose("Using zotero.org style");
            // Check if independent style from zotero repo
            if ((typeof this.cslShortNames[zcreq.styleUrlObj.shortName] != 'undefined') && 
                (this.cslShortNames[zcreq.styleUrlObj.shortName] === true))
            {
                var filename = cslFetcher.cslPath + '/' + zcreq.styleUrlObj.shortName + '.csl';
                log.verbose('Loading independent style from file ' + filename);
                // FIXME:  also, for debugging, for now, force the style filename
                //filename = './csl/modern-language-association.csl';
                
                fs.readFile(filename, 'utf8', function(err, data) {
                    if (err) {
                        callback('Error loading style from file ' + filename + ": " + err);
                        return;
                    }
                    zcreq.cslXml = data;
                    callback(null);
                    return;
                });
            }
            
            // Check if dependent file from zotero repo
            else if (typeof this.cslDependentShortNames[zcreq.styleUrlObj.shortName] != 'undefined') {
                if (typeof this.cslShortNames[zcreq.styleUrlObj.shortName] == "string") {
                    // FIXME:  What to do here?
                }
            }
        }
        else {
            log.verbose("Non-zotero style requested");
            callback("Non-Zotero styles are not supported at this time");
            return;
            /*
              var cslXml = '';
              var fetchConn = http.createClient(80, urlObj.host);
              var request = fetchConn.request('GET', urlObj.pathname,
                  {'host': urlObj.host});
              request.on('response', function(response){
                  if(response.statusCode != 200){
                      throw {'message': 'Error fetching CSL'};
                  }
                  response.setEncoding('utf8');
                  response.on('data', function(chunk){
                      cslXml += chunk;
                  });
                  response.on('end', function(){
                      zcreq.cslXml = cslXml;
                      callback(null);
                  });
              });
              request.end();
            */
        }
    }
    catch (err) {
        callback(err);
        return;
    }
};


cslFetcher.readDependent = function(xml){
    log.verbose("cslFetcher.readDependent");
    xml = xml.replace(/\s*<\?[^>]*\?>\s*\n*/g, "");
    xml = xml.replace(/<style\s/, "<cslstyle ").replace("</style", "</cslstyle");
    xml = xml.trim();
    
    var jsdom = require('jsdom').jsdom;
    var dStyle = jsdom(xml);//parser.parseFromString(xml);
    var linkEls = dStyle.getElementsByTagName('link');
    for(var i = 0; i < linkEls.length; i++){
        log.verbose(linkEls[i].getAttribute("rel"));
        if(linkEls[i].getAttribute("rel") == "independent-parent"){
            log.verbose("independent-parent found: " + linkEls[i].getAttribute("href"));
            return linkEls[i].getAttribute("href");
        }
    }
    return false;
};

if (typeof module !== 'undefined' && "exports" in module) {
    exports.cslFetcher = cslFetcher;
}
